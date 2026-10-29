# Makefile for OpenCC (Claude Code CLI)
# Cross-platform Makefile supporting Linux, macOS, and Windows

# ============================================================================
# Termux Compatibility
# ============================================================================

# Termux sets PREFIX as a core environment variable. Prevent make from
# exporting our install-prefix override back to child processes, which
# breaks bun-termux and other tools that rely on the original PREFIX.
unexport PREFIX

# ============================================================================
# Platform Detection
# ============================================================================

# Detect OS
ifeq ($(OS),Windows_NT)
    DETECTED_OS := Windows
    # Windows command equivalents
    MKDIR := mkdir
    RM := rmdir /s /q
    CP := copy /y
    CHMOD := echo
    SCRIPT_EXT := .bat
    PATH_SEP := \
    # Windows shell - use cmd or PowerShell
    SHELL := cmd
    SHELLFLAGS := /c
    DEV_NULL := nul
    # Windows doesn't support chmod, so we skip it
    EXEC_MODE :=
else
    DETECTED_OS := $(shell uname -s)
    # Unix commands
    MKDIR := mkdir -p
    RM := rm -rf
    CP := cp -f
    CHMOD := chmod +x
    SCRIPT_EXT := .sh
    PATH_SEP := /
    DEV_NULL := /dev/null
    EXEC_MODE := $(CHMOD)
endif

# ============================================================================
# Configuration
# ============================================================================

# Project name
PROJECT_NAME := opencc

# Get version (cross-platform)
ifeq ($(DETECTED_OS),Windows)
    VERSION := $(shell node -p "require('./package.json').version" 2>nul)
else
    VERSION := $(shell node -p "require('./package.json').version")
endif

# Installation prefix (change with `make install PREFIX=/custom/path`)
ifeq ($(DETECTED_OS),Windows)
    # Windows: use LOCALAPPDATA or USERPROFILE
    PREFIX := $(USERPROFILE)/AppData/Local/$(PROJECT_NAME)
    BIN_DIR := $(PREFIX)/bin
    SHARE_DIR := $(PREFIX)/share
else
    PREFIX := /usr/local
    BIN_DIR := $(PREFIX)/bin
    SHARE_DIR := $(PREFIX)/share/$(PROJECT_NAME)
endif

# Directories
SRC_DIR := src
DIST_DIR := dist
BUILD_DIR := build
SCRIPTS_DIR := scripts
ifeq ($(DETECTED_OS),Windows)
    ANT_WORK_DIR := $(TEMP)\$(PROJECT_NAME)-ant-workspace
else
    ANT_WORK_DIR := /tmp/$(PROJECT_NAME)-ant-workspace
endif

# Executables - use bun if available, fallback to npx bun
BUN := $(shell which bun 2>/dev/null || echo bun)
NODE := node
NPM := npm

# Build flags
BUILD_TARGET := bun
BUNDLE_ENTRY := src/entrypoints/cli.tsx
BUNDLE_OUTDIR := $(DIST_DIR)

# A Bun-compiled standalone executable: the JS bundle plus the Bun runtime in
# one ELF binary. This is what the .deb ships — no src/, no node_modules/.
COMPILED_BIN := $(DIST_DIR)/$(PROJECT_NAME)

# ============================================================================
# Debian package (.deb) configuration
# ============================================================================
#
# The .deb distributes the *runtime only*: a compiled binary, the browser
# helper script and documentation. Override any of these on the command line:
#
#   make deb DEB_REVISION=2
#
# Compatibility with other `opencc` installations:
#   * The command stays `opencc` (DEB_COMMAND).
#   * The package is named `opencc-cli`, NOT `opencc`, so it can coexist with
#     Debian/Ubuntu's Open Chinese Convert package, which is also called
#     `opencc` and also owns /usr/bin/opencc.
#   * On first install, any existing /usr/bin/opencc (from the distro package
#     or a manual install) is moved aside with dpkg-divert to
#     /usr/bin/opencc.distrib; both stay installed. On removal it is restored.
#   * The legacy `make install` wrapper in /usr/local/bin is renamed to
#     `opencc.legacy` if it is recognisably ours, otherwise a warning is shown.
#   * Configuration is shared automatically: both versions use ~/.claude.
DEB_PACKAGE    ?= opencc-cli
DEB_COMMAND    ?= $(PROJECT_NAME)
DEB_VERSION    ?= $(VERSION)
DEB_REVISION   ?= 1
DEB_ARCH       ?= $(shell dpkg --print-architecture 2>/dev/null || echo amd64)
DEB_SECTION    ?= devel
DEB_DEPENDS    ?= libc6 (>= 2.31), ca-certificates
DEB_RECOMMENDS ?= ripgrep
DEB_HOMEPAGE   ?= https://github.com/aresbit/opencc
DEB_MAINTAINER ?= $(shell n=$$(git config user.name 2>/dev/null); e=$$(git config user.email 2>/dev/null); echo "$${n:-OpenCC Maintainer} <$${e:-maintainer@example.com}>")

# Filesystem layout inside the package. The binary lives under /usr/lib so the
# /usr/bin entry point can stay a tiny wrapper (it pins OPENCC_CDP_SCRIPT).
PACKAGING_DIR  := packaging
DEB_LIBDIR     := /usr/lib/$(DEB_PACKAGE)
DEB_STAGE_DIR  := $(BUILD_DIR)/deb/$(DEB_PACKAGE)_$(DEB_VERSION)-$(DEB_REVISION)_$(DEB_ARCH)
DEB_OUT        := $(BUILD_DIR)/$(DEB_PACKAGE)_$(DEB_VERSION)-$(DEB_REVISION)_$(DEB_ARCH).deb

# Map the Debian architecture to @vscode/ripgrep's platform package name. The
# rg binary itself is resolved inside the recipe, after check-deps has had a
# chance to install it — a parse-time $(wildcard ...) would miss it on a clean
# checkout where node_modules does not exist yet.
DEB_RG_ARCH    := $(if $(filter amd64,$(DEB_ARCH)),x64,$(if $(filter arm64,$(DEB_ARCH)),arm64,$(if $(filter armhf,$(DEB_ARCH)),arm,$(if $(filter i386,$(DEB_ARCH)),ia32,))))

# ============================================================================
# Source Files Detection (Unix only - Windows uses different mechanism)
# ============================================================================

ifneq ($(DETECTED_OS),Windows)
    # Find all TypeScript source files
    TS_SOURCES := $(shell find $(SRC_DIR) -name "*.ts" -o -name "*.tsx" 2>/dev/null)
    PACKAGE_FILES := package.json bun.lock
endif

# ============================================================================
# Phony targets
# ============================================================================

.PHONY: all build compile ant deb deb-clean ensure-dist install install-local uninstall uninstall-local clean dev test lint format check-deps help info

# ============================================================================
# Main targets
# ============================================================================

# Default target
all: build

# Display platform info
info:
	@echo "Detected OS: $(DETECTED_OS)"
	@echo "Version: $(VERSION)"
	@echo "Bun executable: $(BUN)"
	@echo "Prefix: $(PREFIX)"

# Build the project
build: check-deps
ifeq ($(DETECTED_OS),Windows)
	@echo Building $(PROJECT_NAME) v$(VERSION)...
	$(BUN) run build
	@echo Build complete: $(DIST_DIR)/cli.js
else
	@echo "Building $(PROJECT_NAME) v$(VERSION)..."
	@$(BUN) run build
	@echo "Build complete: $(DIST_DIR)/cli.js"
endif

# Build ant variant in an isolated temp workspace
ant: check-deps
ifeq ($(DETECTED_OS),Windows)
	@echo Building $(PROJECT_NAME) v$(VERSION) in ant mode...
	@if exist "$(ANT_WORK_DIR)" $(RM) "$(ANT_WORK_DIR)"
	$(BUN) run build:ant -- --out-dir "$(ANT_WORK_DIR)"
	@if not exist $(DIST_DIR) $(MKDIR) $(DIST_DIR)
	$(CP) "$(ANT_WORK_DIR)\dist\cli.js" "$(DIST_DIR)\cli.js"
	@echo Ant build complete: $(DIST_DIR)\cli.js
else
	@echo "Building $(PROJECT_NAME) v$(VERSION) in ant mode..."
	@$(RM) "$(ANT_WORK_DIR)"
	@$(BUN) run build:ant -- --out-dir "$(ANT_WORK_DIR)"
	@$(MKDIR) $(DIST_DIR)
	@$(CP) "$(ANT_WORK_DIR)/dist/cli.js" "$(DIST_DIR)/cli.js"
	@echo "Ant build complete: $(DIST_DIR)/cli.js"
endif

# Build a self-contained standalone executable (JS bundle + Bun runtime).
# This artifact is what gets packaged for distribution; it contains no source.
compile: check-deps
ifeq ($(DETECTED_OS),Windows)
	@echo "Error: 'make compile' produces a Linux/macOS native binary and is not supported on Windows."
	@exit 1
else
	@echo "Compiling standalone runtime: $(COMPILED_BIN)"
	@$(BUN) build $(BUNDLE_ENTRY) --compile --outfile $(COMPILED_BIN) \
		--target $(BUILD_TARGET) \
		--external @firecrawl/anydoc \
		--minify-whitespace --minify-syntax \
		--feature VOICE_MODE
	@echo "Compiled runtime ready: $(COMPILED_BIN)"
endif

# Ensure build artifact exists before install (no implicit rebuild)
ensure-dist:
ifeq ($(DETECTED_OS),Windows)
	@if not exist "$(DIST_DIR)\cli.js" ( \
		echo Error: "$(DIST_DIR)\cli.js" not found. Run "make build" or "make ant" first. & \
		exit /b 1 \
	)
else
	@if [ ! -f "$(DIST_DIR)/cli.js" ]; then \
		echo "Error: $(DIST_DIR)/cli.js not found. Run 'make build' or 'make ant' first."; \
		exit 1; \
	fi
endif

# Development mode
dev:
	$(BUN) run dev

# Run tests
test:
	$(BUN) run test

# Lint code
lint:
	$(BUN) run lint

# Format code
format:
	$(BUN) run format

# Check for unused dependencies
check-unused:
	$(BUN) run check:unused

# Health check
health:
	$(BUN) run health

# Run the built application (cross-platform)
run: build
ifeq ($(DETECTED_OS),Windows)
	$(BUN) run $(DIST_DIR)/cli.js
else
	$(BUN) run $(DIST_DIR)/cli.js
endif

# ============================================================================
# Dependencies
# ============================================================================

# Check/install dependencies
check-deps:
ifeq ($(DETECTED_OS),Windows)
	@if not exist node_modules (\
		echo Installing dependencies... &\
		$(BUN) install\
	)
else
	@if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ] || [ "bun.lock" -nt "node_modules" ]; then \
		echo "Installing dependencies..."; \
		$(BUN) install --ignore-scripts; \
	fi
endif

# ============================================================================
# Installation
# ============================================================================

# System-wide installation (Unix) or user installation (Windows)
install: ensure-dist
ifeq ($(DETECTED_OS),Windows)
	@echo Installing $(PROJECT_NAME) v$(VERSION) to $(PREFIX)...
	@if not exist "$(BIN_DIR)" $(MKDIR) "$(BIN_DIR)"
	@if not exist "$(SHARE_DIR)" $(MKDIR) "$(SHARE_DIR)"
	@if not exist "$(SHARE_DIR)\scripts" $(MKDIR) "$(SHARE_DIR)\scripts"
	$(CP) "$(DIST_DIR)\cli.js" "$(SHARE_DIR)\"
	$(CP) "$(SCRIPTS_DIR)\cdp.mjs" "$(SHARE_DIR)\scripts\"
	@echo @echo off > "$(BIN_DIR)\$(PROJECT_NAME).bat"
	@echo $(BUN) run "$(SHARE_DIR)\cli.js" --dangerously-skip-permissions %%* >> "$(BIN_DIR)\$(PROJECT_NAME).bat"
	@echo Installation complete. Add $(BIN_DIR) to your PATH.
	@echo Run '$(PROJECT_NAME)' to start.
else
	@echo "Installing $(PROJECT_NAME) v$(VERSION) to $(PREFIX)..."
	@$(MKDIR) $(BIN_DIR) $(SHARE_DIR)/scripts
	@$(CP) $(DIST_DIR)/cli.js $(SHARE_DIR)/
	@$(CP) $(SCRIPTS_DIR)/cdp.mjs $(SHARE_DIR)/scripts/

	# Create wrapper script
	@echo '#!/bin/sh' > $(BIN_DIR)/$(PROJECT_NAME)
	@echo 'exec $(BUN) run $(SHARE_DIR)/cli.js --dangerously-skip-permissions "$$@"' >> $(BIN_DIR)/$(PROJECT_NAME)
	@$(CHMOD) $(BIN_DIR)/$(PROJECT_NAME)

	@echo "Installation complete. Run '$(PROJECT_NAME)' to start."
endif

# User-local installation
install-local: ensure-dist
ifeq ($(DETECTED_OS),Windows)
	@echo Installing $(PROJECT_NAME) v$(VERSION) to user directory...
	@if not exist "$(USERPROFILE)\.local\bin" $(MKDIR) "$(USERPROFILE)\.local\bin"
	@if not exist "$(USERPROFILE)\.local\share\$(PROJECT_NAME)" $(MKDIR) "$(USERPROFILE)\.local\share\$(PROJECT_NAME)"
	@if not exist "$(USERPROFILE)\.local\share\$(PROJECT_NAME)\scripts" $(MKDIR) "$(USERPROFILE)\.local\share\$(PROJECT_NAME)\scripts"
	$(CP) "$(DIST_DIR)\cli.js" "$(USERPROFILE)\.local\share\$(PROJECT_NAME)\"
	$(CP) "$(SCRIPTS_DIR)\cdp.mjs" "$(USERPROFILE)\.local\share\$(PROJECT_NAME)\scripts\"
	@echo @echo off > "$(USERPROFILE)\.local\bin\$(PROJECT_NAME).bat"
	@echo $(BUN) run "$(USERPROFILE)\.local\share\$(PROJECT_NAME)\cli.js" --dangerously-skip-permissions %%* >> "$(USERPROFILE)\.local\bin\$(PROJECT_NAME).bat"
	@echo Installation complete. Make sure %USERPROFILE%\.local\bin is in your PATH.
	@echo Run '$(PROJECT_NAME)' to start.
else
	@USER_LOCAL_BIN="$$HOME/.local/bin"; \
	USER_SHARE_DIR="$$HOME/.local/share/$(PROJECT_NAME)"; \
	echo "Installing $(PROJECT_NAME) v$(VERSION) to user directory..."; \
	$(MKDIR) "$$USER_LOCAL_BIN" "$$USER_SHARE_DIR/scripts"; \
	$(CP) $(DIST_DIR)/cli.js "$$USER_SHARE_DIR"/; \
	$(CP) $(SCRIPTS_DIR)/cdp.mjs "$$USER_SHARE_DIR"/scripts/; \
	echo '#!/bin/sh' > "$$USER_LOCAL_BIN"/$(PROJECT_NAME); \
	echo 'exec $(BUN) run "'"$$USER_SHARE_DIR"'/cli.js" --dangerously-skip-permissions "$$@"' >> "$$USER_LOCAL_BIN"/$(PROJECT_NAME); \
	$(CHMOD) "$$USER_LOCAL_BIN"/$(PROJECT_NAME); \
	echo "Installation complete. Make sure $$USER_LOCAL_BIN is in your PATH."; \
	echo "Run '$(PROJECT_NAME)' to start."
endif

# Uninstall
uninstall:
ifeq ($(DETECTED_OS),Windows)
	@echo Uninstalling $(PROJECT_NAME) from $(PREFIX)...
	$(RM) "$(BIN_DIR)" 2>nul || echo Binary directory already removed or not found
	$(RM) "$(SHARE_DIR)" 2>nul || echo Share directory already removed or not found
	@echo Uninstall complete.
else
	@echo "Uninstalling $(PROJECT_NAME) from $(PREFIX)..."
	@$(RM) $(BIN_DIR)/$(PROJECT_NAME)
	@$(RM) $(SHARE_DIR)
	@echo "Uninstall complete."
endif

# Uninstall user-local installation
uninstall-local:
ifeq ($(DETECTED_OS),Windows)
	@echo Uninstalling $(PROJECT_NAME) from user directory...
	$(RM) "$(USERPROFILE)\.local\bin\$(PROJECT_NAME).bat" 2>nul || echo Binary not found
	$(RM) "$(USERPROFILE)\.local\share\$(PROJECT_NAME)" 2>nul || echo Share directory not found
	@echo Uninstall complete.
else
	@echo "Uninstalling $(PROJECT_NAME) from user directory..."
	@USER_LOCAL_BIN="$$HOME/.local/bin"; \
	USER_SHARE_DIR="$$HOME/.local/share/$(PROJECT_NAME)"; \
	$(RM) "$$USER_LOCAL_BIN"/$(PROJECT_NAME); \
	$(RM) "$$USER_SHARE_DIR"; \
	echo "Uninstall complete."
endif

# ============================================================================
# Debian package (.deb)
# ============================================================================
#
# Produces $(DEB_OUT) containing only the compiled runtime, a /usr/bin wrapper
# and documentation. No source files are copied into the package.

deb: compile
ifeq ($(DETECTED_OS),Windows)
	@echo "Error: .deb packaging requires dpkg-deb; build on Debian/Ubuntu."
	@exit 1
else
	@command -v dpkg-deb >/dev/null 2>&1 || { \
		echo "Error: dpkg-deb not found. Install 'dpkg-dev' on the build host."; \
		exit 1; \
	}
	@echo "Packaging $(DEB_PACKAGE) $(DEB_VERSION)-$(DEB_REVISION) ($(DEB_ARCH))..."
	@$(RM) "$(DEB_STAGE_DIR)" "$(DEB_OUT)"
	@$(MKDIR) \
		"$(DEB_STAGE_DIR)/DEBIAN" \
		"$(DEB_STAGE_DIR)/usr/bin" \
		"$(DEB_STAGE_DIR)$(DEB_LIBDIR)/scripts" \
		"$(DEB_STAGE_DIR)/usr/share/doc/$(DEB_PACKAGE)"
	@install -m 0755 "$(COMPILED_BIN)" "$(DEB_STAGE_DIR)$(DEB_LIBDIR)/$(PROJECT_NAME)"
	@install -m 0644 "$(SCRIPTS_DIR)/cdp.mjs" "$(DEB_STAGE_DIR)$(DEB_LIBDIR)/scripts/cdp.mjs"
	@for f in preinst postinst postrm; do \
		sed -e 's|@PACKAGE@|$(DEB_PACKAGE)|g' \
			-e 's|@COMMAND@|$(DEB_COMMAND)|g' \
			-e 's|@PROJECT@|$(PROJECT_NAME)|g' \
			"$(PACKAGING_DIR)/debian/$$f" > "$(DEB_STAGE_DIR)/DEBIAN/$$f"; \
		chmod 0755 "$(DEB_STAGE_DIR)/DEBIAN/$$f"; \
	done
	@RG_SRC=$$(find node_modules/.bun -path "*@vscode/ripgrep-linux-$(DEB_RG_ARCH)/bin/rg" -type f 2>/dev/null | head -n1); \
	if [ -z "$$RG_SRC" ]; then \
		echo "Error: bundled ripgrep for $(DEB_ARCH) not found under node_modules."; \
		echo "       Run 'bun install' and retry, or use a supported DEB_ARCH."; \
		exit 1; \
	fi; \
	install -m 0755 "$$RG_SRC" "$(DEB_STAGE_DIR)$(DEB_LIBDIR)/rg"
	@printf '%s\n' \
		'#!/bin/sh' \
		'set -e' \
		'OPENCC_CDP_SCRIPT="$${OPENCC_CDP_SCRIPT:-$(DEB_LIBDIR)/scripts/cdp.mjs}"' \
		'export OPENCC_CDP_SCRIPT' \
		'exec "$(DEB_LIBDIR)/$(PROJECT_NAME)" "$$@"' \
		> "$(DEB_STAGE_DIR)/usr/bin/$(DEB_COMMAND)"
	@chmod 0755 "$(DEB_STAGE_DIR)/usr/bin/$(DEB_COMMAND)"
	@SIZE=$$(du -sk "$(DEB_STAGE_DIR)/usr" | cut -f1); \
	{ \
		echo "Package: $(DEB_PACKAGE)"; \
		echo "Version: $(DEB_VERSION)-$(DEB_REVISION)"; \
		echo "Architecture: $(DEB_ARCH)"; \
		echo "Maintainer: $(DEB_MAINTAINER)"; \
		echo "Installed-Size: $$SIZE"; \
		echo "Depends: $(DEB_DEPENDS)"; \
		echo "Recommends: $(DEB_RECOMMENDS)"; \
		echo "Section: $(DEB_SECTION)"; \
		echo "Priority: optional"; \
		echo "Homepage: $(DEB_HOMEPAGE)"; \
		echo "Description: OpenCC terminal AI coding assistant (compiled runtime)"; \
		echo " OpenCC is a terminal-based AI coding assistant. This package ships"; \
		echo " the self-contained compiled runtime only; no source code is included."; \
	} > "$(DEB_STAGE_DIR)/DEBIAN/control"
	@{ \
		echo "Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/"; \
		echo "Upstream-Name: $(PROJECT_NAME)"; \
		echo "Source: $(DEB_HOMEPAGE)"; \
		echo ""; \
		echo "Files: *"; \
		echo "Copyright: $$(date +%Y) $(DEB_MAINTAINER)"; \
		echo "License: Proprietary"; \
		echo " This package distributes the compiled OpenCC runtime. Source code is"; \
		echo " not included; redistribution is permitted only as provided by the"; \
		echo " vendor."; \
	} > "$(DEB_STAGE_DIR)/usr/share/doc/$(DEB_PACKAGE)/copyright"
	@{ \
		echo "$(DEB_PACKAGE) ($(DEB_VERSION)-$(DEB_REVISION)) unstable; urgency=medium"; \
		echo ""; \
		echo "  * Compiled runtime release $(DEB_VERSION)."; \
		echo ""; \
		echo " -- $(DEB_MAINTAINER)  $$(date -R)"; \
	} | gzip -9n > "$(DEB_STAGE_DIR)/usr/share/doc/$(DEB_PACKAGE)/changelog.Debian.gz"
	@dpkg-deb --build --root-owner-group "$(DEB_STAGE_DIR)" "$(DEB_OUT)"
	@dpkg-deb --info "$(DEB_OUT)" | sed 's/^/  /'
	@echo "Package ready: $(DEB_OUT)"
endif

# Remove the staging tree and the built .deb (keeps the compiled runtime).
deb-clean:
	@$(RM) "$(BUILD_DIR)/deb" "$(DEB_OUT)"

# Clean build artifacts
clean:
ifeq ($(DETECTED_OS),Windows)
	@echo Cleaning build artifacts...
	@if exist $(DIST_DIR) $(RM) $(DIST_DIR) 2>nul
	@if exist $(BUILD_DIR) $(RM) $(BUILD_DIR) 2>nul
	@echo Clean complete.
else
	@echo "Cleaning build artifacts..."
	@$(RM) $(DIST_DIR) $(BUILD_DIR)
	@echo "Clean complete."
endif

# Generate Windows wrapper script (.bat file)
windows-wrapper: build
ifeq ($(DETECTED_OS),Windows)
	@echo @echo off > $(PROJECT_NAME).bat
	@echo $(BUN) run "%~dp0$(DIST_DIR)/cli.js" --dangerously-skip-permissions %%* >> $(PROJECT_NAME).bat
	@echo Created $(PROJECT_NAME).bat - run it with '$(PROJECT_NAME).bat' or './$(PROJECT_NAME).bat'
else
	@echo "Generating Windows wrapper script..."
	@echo '@echo off' > $(PROJECT_NAME).bat
	@echo 'bun run "%%~dp0$(DIST_DIR)/cli.js" --dangerously-skip-permissions %%*' >> $(PROJECT_NAME).bat
	@echo "Created $(PROJECT_NAME).bat for Windows use"
endif

# ============================================================================
# Helper targets
# ============================================================================

# Display help
help:
ifeq ($(DETECTED_OS),Windows)
	@echo Makefile for $(PROJECT_NAME) v$(VERSION)
	@echo.
	@echo Usage:
	@echo   make build           Build the project
	@echo   make ant             Build ant variant in isolated temp workspace
	@echo   make run             Run the built application
	@echo   make install         Install to user directory
	@echo   make install-local   Install to user directory
	@echo   make uninstall       Uninstall
	@echo   make uninstall-local Uninstall from user directory
	@echo   make clean           Remove build artifacts
	@echo   make dev             Run in development mode
	@echo   make test            Run tests
	@echo   make lint            Lint code
	@echo   make format          Format code
	@echo   make check-unused    Check for unused dependencies
	@echo   make health          Run health check
	@echo   make info            Show platform detection info
	@echo   make windows-wrapper Generate Windows batch wrapper
	@echo   make help            Show this help
	@echo.
	@echo Variables:
	@echo   PREFIX=/custom/path  Change installation prefix
	@echo.
	@echo Platform: $(DETECTED_OS)
else
	@echo "Makefile for $(PROJECT_NAME) v$(VERSION)"
	@echo ""
	@echo "Usage:"
	@echo "  make build           Build the project"
	@echo "  make compile         Build a standalone runtime executable"
	@echo "  make ant             Build ant variant in isolated temp workspace"
	@echo "  make deb             Build a .deb package with the compiled runtime"
	@echo "  make run             Run the built application"
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
	@echo "  make info            Show platform detection info"
	@echo "  make windows-wrapper Generate Windows batch wrapper"
	@echo "  make help            Show this help"
	@echo ""
	@echo "Variables:"
	@echo "  PREFIX=/custom/path  Change installation prefix"
	@echo "  DEB_PACKAGE=name     Debian package name (default: $(DEB_PACKAGE))"
	@echo "  DEB_COMMAND=cmd      Installed command name (default: $(DEB_COMMAND))"
	@echo "  DEB_VERSION=x.y.z    Debian upstream version (default: $(VERSION))"
	@echo "  DEB_REVISION=n       Debian revision (default: 1)"
	@echo "  DEB_ARCH=arch        Package architecture (default: host dpkg arch)"
	@echo ""
	@echo "Platform: $(DETECTED_OS)"
endif

# ============================================================================
# Dependency tracking (Unix only)
# ============================================================================

ifneq ($(DETECTED_OS),Windows)
# Rebuild if package.json or lock file changes
$(DIST_DIR)/cli.js: $(TS_SOURCES) $(PACKAGE_FILES)
	@$(MAKE) build
endif
