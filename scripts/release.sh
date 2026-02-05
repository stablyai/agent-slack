#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_step() {
  printf "${BLUE}==>${NC} %s\n" "$1"
}

print_success() {
  printf "${GREEN}==>${NC} %s\n" "$1"
}

print_warning() {
  printf "${YELLOW}==>${NC} %s\n" "$1"
}

print_error() {
  printf "${RED}error:${NC} %s\n" "$1" >&2
}

usage() {
  printf '%s\n' "Usage: $0 <version>"
  printf '%s\n' ""
  printf '%s\n' "Arguments:"
  printf '%s\n' "  version    Version number (e.g., 0.2.0) or bump type (patch, minor, major)"
  printf '%s\n' ""
  printf '%s\n' "Examples:"
  printf '%s\n' "  $0 0.2.0     # Set version to 0.2.0"
  printf '%s\n' "  $0 patch     # Bump patch version (0.1.0 -> 0.1.1)"
  printf '%s\n' "  $0 minor     # Bump minor version (0.1.0 -> 0.2.0)"
  printf '%s\n' "  $0 major     # Bump major version (0.1.0 -> 1.0.0)"
  exit 1
}

# Check for version argument
if [ $# -eq 0 ]; then
  print_error "version argument required"
  printf '\n'
  usage
fi

version_arg="$1"

# Get current version from package.json
current_version=$(node -p "require('./package.json').version")

# Calculate new version based on argument
case "$version_arg" in
  patch)
    new_version=$(printf '%s' "$current_version" | awk -F. '{printf "%d.%d.%d", $1, $2, $3+1}')
    ;;
  minor)
    new_version=$(printf '%s' "$current_version" | awk -F. '{printf "%d.%d.0", $1, $2+1}')
    ;;
  major)
    new_version=$(printf '%s' "$current_version" | awk -F. '{printf "%d.0.0", $1+1}')
    ;;
  *)
    # Validate version format (semver: X.Y.Z)
    if ! printf '%s' "$version_arg" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
      print_error "invalid version format: $version_arg"
      printf '%s\n' "Version must be in format X.Y.Z (e.g., 0.2.0) or a bump type (patch, minor, major)"
      exit 1
    fi
    new_version="$version_arg"
    ;;
esac

tag="v$new_version"

# Pre-flight checks
print_step "Running pre-flight checks..."

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  print_error "you have uncommitted changes. Please commit or stash them first."
  exit 1
fi

# Check if tag already exists
if git rev-parse "$tag" >/dev/null 2>&1; then
  print_error "tag $tag already exists"
  exit 1
fi

# Check if on main/master branch
current_branch=$(git branch --show-current)
if [ "$current_branch" != "main" ] && [ "$current_branch" != "master" ]; then
  print_warning "You are on branch '$current_branch', not main/master"
fi

# Show what will happen
printf '\n'
printf '%s\n' "Release Summary"
printf '%s\n' "==============="
printf '%s\n' "  Current version: $current_version"
printf '%s\n' "  New version:     $new_version"
printf '%s\n' "  Git tag:         $tag"
printf '%s\n' "  Branch:          $current_branch"
printf '\n'

# Confirmation prompt
printf "${YELLOW}This will:${NC}\n"
printf '%s\n' "  1. Update version in package.json to $new_version"
printf '%s\n' "  2. Create a git commit with message \"$tag\""
printf '%s\n' "  3. Create git tag \"$tag\""
printf '%s\n' "  4. Push commit and tag to origin"
printf '\n'

printf '%s' "Proceed with release? [y/N] "
read -r confirm
case "$confirm" in
  [yY]|[yY][eE][sS])
    ;;
  *)
    printf '%s\n' "Aborted."
    exit 0
    ;;
esac

printf '\n'

# Step 1: Update version in package.json
print_step "Updating version in package.json to $new_version..."
# Use node to update package.json to preserve formatting
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$new_version';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
print_success "Updated package.json"

# Step 2: Create git commit
print_step "Creating git commit..."
git add package.json
git commit -m "$tag"
print_success "Created commit \"$tag\""

# Step 3: Create git tag
print_step "Creating git tag $tag..."
git tag "$tag"
print_success "Created tag $tag"

# Step 4: Push to origin
print_step "Pushing commit and tag to origin..."
git push origin "$current_branch"
git push origin "$tag"
print_success "Pushed to origin"

printf '\n'
print_success "Release $tag complete!"
printf '%s\n' ""
printf '%s\n' "Next steps:"
printf '%s\n' "  - The GitHub release workflow should now be triggered"
printf '%s\n' "  - Check the Actions tab for build progress"
printf '%s\n' "  - Once complete, the release will be available at:"
printf '%s\n' "    https://github.com/nwparker/agent-slack/releases/tag/$tag"
