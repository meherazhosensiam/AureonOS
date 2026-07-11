.PHONY: all clean extension potfile install prefs enable disable reset info show updatepo zip-file

GETTEXT_DOMAIN = arcmenu
NAME = ArcMenu
RESOURCES_PATH = /org/gnome/shell/extensions/arcmenu
SETTINGS_SCHEMA = org.gnome.shell.extensions.arcmenu
UUID = arcmenu@arcmenu.com

# Files and directories to build into extension.
# src/* flattens the src directory to root.
PACKAGE_FILES = \
	LICENSE \
	metadata.json \
	README.md \
	RELEASENOTES.md \
	src/*

# Directories to scan for .js and .ui files.
# `make potfile` uses xgettext to extract strings to build the .pot template.
I18N_DIRS = src/

# If VERSION is provided via CLI, suffix ZIP_NAME with _$(VERSION).
# Otherwise, inject git commit SHA (if available) into metadata.json.
COMMIT = $(if $(VERSION),,$(shell git rev-parse HEAD))
ZIP_NAME = $(UUID)$(if $(VERSION),_$(VERSION),)

ifeq ($(strip $(DESTDIR)),)
	INSTALLTYPE = local
	INSTALLBASE = $(HOME)/.local/share/gnome-shell/extensions
else
	INSTALLTYPE = system
	SHARE_PREFIX = $(DESTDIR)/usr/share
	INSTALLBASE = $(SHARE_PREFIX)/gnome-shell/extensions
endif

define CLEAN_UP
@echo 'Cleaning up...'
@-rm -fR _build
@-rm -fR _po
@-rm -f ./schemas/gschemas.compiled
@-rm -f ./data/resources.gresource
@-rm -f ./po/*.po~
@-rm -f ./po/*.mo
@echo "Done."
endef

all: extension

clean:
	$(CLEAN_UP)

extension: _compile-resources _compile-schemas _compile-translations

_compile-resources:
	@mkdir -p data/
	@if find data/ -mindepth 2 -type f -name "*.svg" | grep -q .; then \
		echo "Creating resources.gresource.xml..."; \
		FILES=$$(find data/ -mindepth 2 -type f -name "*.svg" \
		          -printf '    <file compressed="true" preprocess="xml-stripblanks">%P</file>\n' | \
		          sort -V); \
		printf "<?xml version='1.0' encoding='UTF-8'?>\n<gresources>\n  <gresource prefix='$(RESOURCES_PATH)'>\n$$FILES\n  </gresource>\n</gresources>" \
			> data/resources.gresource.xml; \
		echo "Done."; \
		command -v glib-compile-resources >/dev/null 2>&1 || { echo "Error: glib-compile-resources not found. Install 'glib2-devel' or 'libglib2.0-dev'."; exit 1; }; \
		echo "Compiling resources.gresource.xml..."; \
		glib-compile-resources --sourcedir=data data/resources.gresource.xml; \
		echo "Done."; \
	else \
		echo "No resources found in data/. Skipping compile-resources..."; \
	fi

_compile-schemas: ./schemas/$(SETTINGS_SCHEMA).gschema.xml
	@command -v glib-compile-schemas >/dev/null 2>&1 || { echo "Error: glib-compile-schemas not found. Install 'glib2-devel' or 'libglib2.0-dev'."; exit 1; }
	@echo "Compiling $(SETTINGS_SCHEMA).gschema.xml..."
	@glib-compile-schemas --strict ./schemas/ || { echo "Error: glib-compile-schemas failed!."; exit 1; }
	@echo "Done."

# Prep .po files for compilation into .mo files.
# Omits untranslated messages, fuzzy messages (except the header entry), and obsolete messages from the output.
_buildpo:
	@command -v msgmerge >/dev/null 2>&1 || { echo "Error: msgmerge not found. Install 'gettext' package."; exit 1; }
	@-rm -fR ./_po
	@mkdir -p _po
	@echo "Updating po files..."
	@for PO_FILE in po/*.po; do \
		LANG=$$(basename "$$PO_FILE" .po); \
		msgmerge --for-msgfmt --no-location -q $$PO_FILE ./po/$(GETTEXT_DOMAIN).pot > _po/$$LANG.po; \
	done;
	@echo "Done."

_compile-translations: _buildpo
	@command -v msgfmt >/dev/null 2>&1 || { echo "Error: msgfmt not found. Install 'gettext' package."; exit 1; }
	@echo "Compiling translations..."
	@for PO_FILE in _po/*.po; do \
		LANG=$$(basename "$$PO_FILE" .po); \
		msgfmt -c "$$PO_FILE" -o "po/$$LANG.mo"; \
	done;
	@echo "Done."

potfile:
	@command -v xgettext >/dev/null 2>&1 || { echo "Error: xgettext not found. Install 'gettext' package."; exit 1; }
	@echo "Creating $(GETTEXT_DOMAIN).pot file..."
	@mkdir -p po
	@find $(I18N_DIRS) \( -name '*.js' -o -name '*.ui' \) | xargs \
	xgettext \
		--from-code=UTF-8 \
		--output=po/$(GETTEXT_DOMAIN).pot \
		--sort-by-file \
		--add-comments=TRANSLATORS \
		--package-name "$(NAME)"
	@echo "Done."

updatepo: potfile
	@command -v msgmerge >/dev/null 2>&1 || { echo "Error: msgmerge not found. Install 'gettext' package."; exit 1; }
	@echo "Updating po files..."
	@for PO_FILE in po/*.po; do \
		msgmerge -NU $$PO_FILE ./po/$(GETTEXT_DOMAIN).pot; \
	done;
	@echo "Done."
	$(CLEAN_UP)

install: _build
	@echo "Installing to $(INSTALLBASE)..."
	@rm -rf $(INSTALLBASE)/$(UUID)
	@mkdir -p $(INSTALLBASE)/$(UUID)
	@cp -r ./_build/* $(INSTALLBASE)/$(UUID)/
	@if [ "$(INSTALLTYPE)" = "system" ]; then \
		rm -r $(INSTALLBASE)/$(UUID)/schemas $(INSTALLBASE)/$(UUID)/locale; \
		mkdir -p $(SHARE_PREFIX)/glib-2.0/schemas $(SHARE_PREFIX)/locale; \
		cp -r ./schemas/*gschema.* $(SHARE_PREFIX)/glib-2.0/schemas; \
		cp -r ./_build/locale/* $(SHARE_PREFIX)/locale; \
	fi
	@echo "Done."
	$(CLEAN_UP)

prefs enable disable reset info show:
	gnome-extensions $@ $(UUID)

zip-file: _build
	@echo "Bundling zip file..."
	@cd _build; \
	zip -qr "$(ZIP_NAME).zip" . -x "schemas/gschemas.compiled"
	@mv _build/$(ZIP_NAME).zip ./
	@echo "Done."
	$(CLEAN_UP)

_build: all
	@echo "Building extension..."
	@-rm -fR ./_build
	@mkdir -p _build
	@cp -r $(PACKAGE_FILES) _build
	@mkdir -p _build/schemas
	@cp schemas/*.xml _build/schemas/
	@cp schemas/gschemas.compiled _build/schemas/
	@mkdir -p _build/data
	@cp data/resources.gresource _build/data/resources.gresource
	@mkdir -p _build/locale
	@for MO_FILE in po/*.mo; do \
		lf=_build/locale/`basename $$MO_FILE .mo`; \
		mkdir -p $$lf; \
		mkdir -p $$lf/LC_MESSAGES; \
		cp $$MO_FILE $$lf/LC_MESSAGES/$(GETTEXT_DOMAIN).mo; \
	done;
	@if [ -n "$(COMMIT)" ]; then \
		sed -i '/"version": .*,/a \  "commit": "$(COMMIT)",' _build/metadata.json; \
	fi
	@echo "Done."