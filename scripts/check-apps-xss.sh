#!/usr/bin/env bash
# check-apps-xss.sh — fail if an apps-bundle writes to innerHTML without
# an escapeHtml() call in the same file.
#
# Rationale: apps-bundles render user-generated content (notes, inbox,
# standup) into the DOM of an authenticated session. One missed escape is
# a stored-XSS that runs with the victim's session cookie. Every bundle
# that uses innerHTML must define/call escapeHtml on interpolated data.
#
# Wired into .pre-commit-config.yaml as a local hook.
set -euo pipefail

fail=0
for file in "$@"; do
  case "$file" in
    apps-bundles/*.html) ;;
    *) continue ;;
  esac
  if grep -q 'innerHTML' "$file" && ! grep -q 'escapeHtml' "$file"; then
    echo "XSS guard: $file uses innerHTML but never calls escapeHtml()." >&2
    echo "  Escape all interpolated values with escapeHtml() before writing to innerHTML." >&2
    fail=1
  fi
done
exit $fail