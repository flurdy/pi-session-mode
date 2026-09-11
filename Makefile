PI_AGENT_DIR ?= $(HOME)/.pi/agent
PI_EXTENSIONS_DIR ?= $(PI_AGENT_DIR)/extensions

.DEFAULT_GOAL := help

.PHONY: help apply verify-apply check test typecheck verify-git-install

help:
	@echo "make apply               Link this reviewed checkout into $(PI_EXTENSIONS_DIR)"
	@echo "make verify-apply        Verify the local extension link"
	@echo "make check               Run tests, typechecking, and package checks"
	@echo "make verify-git-install  Verify isolated immutable Git installation"

apply:
	mkdir -p "$(PI_EXTENSIONS_DIR)"
	ln -sfn "$(CURDIR)" "$(PI_EXTENSIONS_DIR)/flurdy-session-mode"
	$(MAKE) verify-apply
	@echo "Restart Pi after first linking; reload releases and reacquires the lease."

verify-apply:
	test "$$(readlink "$(PI_EXTENSIONS_DIR)/flurdy-session-mode")" = "$(CURDIR)"

check:
	npm run check

test:
	npm test

typecheck:
	npm run typecheck

verify-git-install:
	npm run verify:git-install
