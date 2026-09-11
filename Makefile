# ==============================================================================
# AuraStream Real-Time Spatial Audio Engine Makefile
# High-Performance C++17 Binaural Convolver for Native & WebAssembly (AudioWorklet)
# ==============================================================================

CXX ?= clang++
CXXFLAGS = -O3 -std=c++17 -Wall -Wextra -Werror -I./include -fPIC -fvisibility=hidden

# Source files
SRCS = src/FastFFT.cpp src/BinauralConvolver.cpp src/AuraStreamCAPI.cpp
TEST_SRCS = test/test_main.cpp

# Output directories
BUILD_DIR = build
BIN_DIR = bin

# Native test target
TARGET_TEST = $(BIN_DIR)/test_aurastream

# Emscripten configuration
EMCC ?= emcc
EMCXX ?= em++

# Exported C API functions for Emscripten
WASM_EXPORTS = "[\
'_init_engine',\
'_load_hrir_table',\
'_set_source_position',\
'_process_audio',\
'_set_hrir_direction',\
'_reset_source',\
'_get_block_size',\
'_get_max_filter_len',\
'_get_max_sources',\
'_malloc',\
'_free'\
]"

WASM_FLAGS = -O3 \
             -std=c++17 \
             -msimd128 \
             -flto \
             -I./include \
             -s STANDALONE_WASM=0 \
             -s MODULARIZE=1 \
             -s 'EXPORT_NAME="AuraStreamEngine"' \
             -s EXPORTED_FUNCTIONS=$(WASM_EXPORTS) \
             -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','getValue','setValue']" \
             -s ALLOW_MEMORY_GROWTH=1 \
             -s INITIAL_MEMORY=16777216 \
             -s MAXIMUM_MEMORY=67108864 \
             -s ENVIRONMENT="web,worker" \
             -s NO_FILESYSTEM=1 \
             -s STRICT=1

# Standalone pure Wasm configuration (without JS glue code)
STANDALONE_WASM_FLAGS = -O3 \
                        -std=c++17 \
                        -msimd128 \
                        -flto \
                        -I./include \
                        -s STANDALONE_WASM=1 \
                        -s EXPORTED_FUNCTIONS=$(WASM_EXPORTS) \
                        --no-entry

.PHONY: all test run_tests wasm standalone_wasm clean

all: test

$(BIN_DIR):
	mkdir -p $(BIN_DIR)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

# ------------------------------------------------------------------------------
# Native Build & Test Target
# ------------------------------------------------------------------------------
test: $(BIN_DIR) $(TARGET_TEST)

$(TARGET_TEST): $(SRCS) $(TEST_SRCS)
	$(CXX) $(CXXFLAGS) $(SRCS) $(TEST_SRCS) -o $(TARGET_TEST)

run_tests: test
	@./$(TARGET_TEST)

# ------------------------------------------------------------------------------
# Emscripten WebAssembly Targets (AudioWorklet & Browser)
# ------------------------------------------------------------------------------
wasm: $(BUILD_DIR)
	@echo "Compiling WebAssembly module with Emscripten (-O3, -msimd128)..."
	$(EMCXX) $(WASM_FLAGS) $(SRCS) -o $(BUILD_DIR)/aurastream.js
	@echo "Generated $(BUILD_DIR)/aurastream.js and $(BUILD_DIR)/aurastream.wasm"

standalone_wasm: $(BUILD_DIR)
	@echo "Compiling Standalone WebAssembly binary (-O3, -msimd128, STANDALONE_WASM=1)..."
	$(EMCXX) $(STANDALONE_WASM_FLAGS) $(SRCS) -o $(BUILD_DIR)/aurastream_standalone.wasm
	@echo "Generated $(BUILD_DIR)/aurastream_standalone.wasm"

# ------------------------------------------------------------------------------
# FastAPI Microservice Targets
# ------------------------------------------------------------------------------
run_service:
	@.venv/bin/uvicorn service.main:app --host 0.0.0.0 --port 8000 --reload

test_service:
	@PYTHONPATH=. .venv/bin/pytest service/tests/ -v

test_web:
	@node web/tests/test_web_engine.mjs

# ------------------------------------------------------------------------------
# Next.js 3D Spatial Canvas Frontend Targets
# ------------------------------------------------------------------------------
run_frontend:
	@cd frontend && npm run dev

build_frontend:
	@cd frontend && npm run build

test_frontend:
	@cd frontend && npm run typecheck

# ------------------------------------------------------------------------------
# Multi-Client Real-Time Synchronization Targets
# ------------------------------------------------------------------------------
run_sync:
	@npx -y tsx sync/server.ts

test_sync:
	@npx -y tsx sync/tests/sync_system.test.ts

clean:
	rm -rf $(BUILD_DIR) $(BIN_DIR) storage/sessions/* storage/uploads/* frontend/.next

