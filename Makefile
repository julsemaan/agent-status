PYTHON ?= python3

.PHONY: bump-version check-versions test check-packages build check

bump-version:
	$(PYTHON) tools/version.py bump "$$VERSION"

check-versions:
	$(PYTHON) tools/version.py check

test:
	$(PYTHON) -m unittest
	npm test

check-packages:
	$(PYTHON) tools/check_npm_packages.py

build:
	rm -rf build dist
	$(PYTHON) -m build
	$(PYTHON) -m twine check dist/*

check: check-versions test check-packages build
