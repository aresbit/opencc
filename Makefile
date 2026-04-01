# Makefile for OpenCC (Claude Code CLI)
# Modern Makefile following best practices for TypeScript/Bun projects

# ============================================================================
# Configuration
# ============================================================================

# Project name
PROJECT_NAME := opencc
VERSION := $(shell node -p "require('./package.json').version")

# Installation prefix (change with `make install PREFIX=/custom/path`)
PREFIX := /usr/local
BIN_DIR := $(PREFIX)/bin
SHARE_DIR := $(PREFIX)/share/$(PROJECT_NAME)

# Directories
SRC_DIR := src
DIST_DIR := dist
BUILD_DIR := build
SCRIPTS_DIR := scripts
TESTS_DIR := tests

# Executables
BUN := bun
NODE := node
NPM := npm
INSTALL := install
CP := cp -f
MKDIR := mkdir -p
RM := rm -rf
LN := ln -sf

# Build flags
BUILD_TARGET := bun
BUNDLE_ENTRY := src/entrypoints/cli.tsx
BUNDLE_OUTDIR := $(DIST_DIR)

# ============================================================================
# Automatic file detection
# ============================================================================

# Find all TypeScript source files
TS_SOURCES := $(shell find $(SRC_DIR) -name "*.ts" -o -name "*.tsx")
# Package JSON files
PACKAGE_FILES := package.json bun.lock

# ============================================================================
# Phony targets
# ============================================================================

.PHONY: all build install install-local uninstall uninstall-local clean dev test lint format check-deps help

# ============================================================================
# Main targets
# ============================================================================

# Default target
all: build

# Build the project
build: check-deps
	@echo "Building $(PROJECT_NAME) v$(VERSION)..."
	@$(BUN) run build
	@echo "Build complete: $(DIST_DIR)/cli.js"

# Development mode
dev:
	@$(BUN) run dev

# Run tests
test:
	@$(BUN) run test

# Lint code
lint:
	@$(BUN) run lint

# Format code
format:
	@$(BUN) run format

# Check for unused dependencies
check-unused:
	@$(BUN) run check:unused

# Health check
health:
	@$(BUN) run health

# Install dependencies
check-deps: package.json bun.lock
	@if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ] || [ "bun.lock" -nt "node_modules" ]; then \
		echo "Installing dependencies..."; \
		$(BUN) install; \
	fi

# ============================================================================
# Installation
# ============================================================================

# System-wide installation (requires sudo)
install: build
	@echo "Installing $(PROJECT_NAME) v$(VERSION) to $(PREFIX)..."
	@$(MKDIR) $(BIN_DIR) $(SHARE_DIR)
	@$(CP) $(DIST_DIR)/cli.js $(SHARE_DIR)/

	# Create wrapper script
	@echo "#!/bin/sh" > $(BIN_DIR)/$(PROJECT_NAME)
	@echo "exec $(BUN) run $(SHARE_DIR)/cli.js --dangerously-skip-permissions \"\$$@\"" >> $(BIN_DIR)/$(PROJECT_NAME)
	@chmod +x $(BIN_DIR)/$(PROJECT_NAME)

	@echo "Installation complete. Run '$(PROJECT_NAME)' to start."

# User-local installation (no sudo required)
install-local: build
	@USER_LOCAL_BIN="$$HOME/.local/bin"; \
	USER_SHARE_DIR="$$HOME/.local/share/$(PROJECT_NAME)"; \
	echo "Installing $(PROJECT_NAME) v$(VERSION) to user directory..."; \
	$(MKDIR) "$$USER_LOCAL_BIN" "$$USER_SHARE_DIR"; \
	$(CP) $(DIST_DIR)/cli.js "$$USER_SHARE_DIR"/; \
	echo "#!/bin/sh" > "$$USER_LOCAL_BIN"/$(PROJECT_NAME); \
	echo "exec $(BUN) run \"$$USER_SHARE_DIR\"/cli.js --dangerously-skip-permissions \"\$$@\"" >> "$$USER_LOCAL_BIN"/$(PROJECT_NAME); \
	chmod +x "$$USER_LOCAL_BIN"/$(PROJECT_NAME); \
	echo "Installation complete. Make sure $$USER_LOCAL_BIN is in your PATH."; \
	echo "Run '$(PROJECT_NAME)' to start."

# Uninstall (system-wide)
uninstall:
	@echo "Uninstalling $(PROJECT_NAME) from $(PREFIX)..."
	@$(RM) $(BIN_DIR)/$(PROJECT_NAME)
	@$(RM) $(SHARE_DIR)
	@echo "Uninstall complete."

# Uninstall user-local installation
uninstall-local:
	@echo "Uninstalling $(PROJECT_NAME) from user directory..."
	@USER_LOCAL_BIN="$$HOME/.local/bin"; \
	USER_SHARE_DIR="$$HOME/.local/share/$(PROJECT_NAME)"; \
	$(RM) "$$USER_LOCAL_BIN"/$(PROJECT_NAME); \
	$(RM) "$$USER_SHARE_DIR"; \
	echo "Uninstall complete."

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@$(RM) $(DIST_DIR) $(BUILD_DIR)
	@echo "Clean complete."

# ============================================================================
# Helper targets
# ============================================================================

# Display help
help:
	@echo "Makefile for $(PROJECT_NAME) v$(VERSION)"
	@echo ""
	@echo "Usage:"
	@echo "  make build           Build the project"
	@echo "  make install         Install system-wide (requires sudo)"
	@echo "  make install-local   Install to user directory (~/.local/)"
	@echo "  make uninstall       Uninstall system-wide"
	@echo "  make uninstall-local Uninstall from user directory"
	@echo "  make clean           Remove build artifacts"
	@echo "  make dev             Run in development mode"
	@echo "  make test            Run tests"
	@echo "  make lint            Lint code"
	@echo "  make format          Format code"
	@echo "  make check-unused    Check for unused dependencies"
	@echo "  make health          Run health check"
	@echo "  make help            Show this help"
	@echo ""
	@echo "Variables:"
	@echo "  PREFIX=/custom/path  Change installation prefix"
	@echo ""
	@echo "Examples:"
	@echo "  sudo make install                     # Install to /usr/local"
	@echo "  make install-local                    # Install to ~/.local/"
	@echo "  make install PREFIX=$$HOME/.local     # Install to custom prefix"

# ============================================================================
# Dependency tracking
# ============================================================================

# Rebuild if package.json or lock file changes
$(DIST_DIR)/cli.js: $(TS_SOURCES) $(PACKAGE_FILES)
	@$(MAKE) build