#!/bin/bash

# CI Test Script - Admin Rotation Implementation (Issue #342)
# This script runs all CI tests as configured in .github/workflows/ci.yml

set -e  # Exit on error

echo "=========================================================================="
echo "StellarCred CI Test Suite - Issue #342: Admin Rotation"
echo "=========================================================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print section headers
print_section() {
    echo ""
    echo "=========================================================================="
    echo "🔹 $1"
    echo "=========================================================================="
    echo ""
}

# Function to print success
print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

# Function to print error
print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Function to print info
print_info() {
    echo -e "${YELLOW}ℹ️  $1${NC}"
}

# Check if cargo is installed
if ! command -v cargo &> /dev/null; then
    print_error "Cargo is not installed. Please install Rust: https://rustup.rs/"
    exit 1
fi

print_success "Cargo found: $(cargo --version)"
print_success "Rust found: $(rustc --version)"

# Test 1: Update Cargo.lock
print_section "Step 1: Update Cargo Lock"
print_info "Running: cargo update --aggressive"
cargo update --aggressive
print_success "Cargo lock updated"

# Test 2: Run Contract Tests
print_section "Step 2: Run Contract Tests"
print_info "Running: cargo test --locked"
print_info "This will run all contract tests including:"
print_info "  - 6 IssuerRegistry admin rotation tests"
print_info "  - 6 CredentialVerifier admin rotation tests"
print_info "  - All existing contract tests"
echo ""

cargo test --locked

if [ $? -eq 0 ]; then
    print_success "All tests passed!"
else
    print_error "Tests failed!"
    exit 1
fi

# Test 3: Build WASM Artifacts
print_section "Step 3: Build WASM Artifacts"
print_info "Running: cargo build --release --target wasm32v1-none --locked"
print_info "This will generate WASM artifacts for deployment"
echo ""

cargo build --release --target wasm32v1-none --locked

if [ $? -eq 0 ]; then
    print_success "WASM artifacts built successfully"
    print_info "Artifacts location: target/wasm32v1-none/release/"
else
    print_error "WASM build failed!"
    exit 1
fi

# Test 4: Lint with Clippy
print_section "Step 4: Lint Check (Clippy)"
print_info "Running: cargo clippy --all-targets -- -D warnings"
print_info "This checks code quality and treats warnings as errors"
echo ""

cargo clippy --all-targets -- -D warnings

if [ $? -eq 0 ]; then
    print_success "No clippy warnings found"
else
    print_error "Clippy warnings or errors found!"
    exit 1
fi

# Test 5: Run Specific Admin Rotation Tests
print_section "Step 5: Run Specific Admin Rotation Tests"
echo ""

print_info "IssuerRegistry Admin Rotation Tests:"
cargo test issuer_registry admin_can_transfer_to_new_admin -- --nocapture
cargo test issuer_registry admin_transfer_moves_roles_to_new_admin -- --nocapture
cargo test issuer_registry only_current_admin_can_rotate -- --nocapture
cargo test issuer_registry post_rotation_new_admin_can_perform_ops -- --nocapture
cargo test issuer_registry post_rotation_old_admin_cannot_perform_ops -- --nocapture
cargo test issuer_registry set_admin_emits_expected_event -- --nocapture
print_success "IssuerRegistry tests completed"

echo ""

print_info "CredentialVerifier Admin Rotation Tests:"
cargo test credential_verifier admin_can_transfer_to_new_admin -- --nocapture
cargo test credential_verifier admin_transfer_moves_roles_to_new_admin -- --nocapture
cargo test credential_verifier only_current_admin_can_rotate -- --nocapture
cargo test credential_verifier post_rotation_new_admin_can_perform_ops -- --nocapture
cargo test credential_verifier post_rotation_old_admin_cannot_perform_ops -- --nocapture
cargo test credential_verifier set_admin_emits_expected_event -- --nocapture
print_success "CredentialVerifier tests completed"

# Final Summary
print_section "✅ CI TEST SUITE COMPLETE"
echo ""
echo "Summary of Results:"
echo "==================="
echo ""
print_success "Cargo lock updated"
print_success "All contract tests passed (12 new + existing)"
print_success "WASM artifacts built successfully"
print_success "No clippy warnings found"
print_success "All specific admin rotation tests passed"
echo ""
print_info "Implementation Status: READY FOR DEPLOYMENT"
print_info "Next: Deploy to testnet and mainnet"
echo ""
echo "=========================================================================="
echo "✅ CI TESTS PASSED - Implementation is production-ready"
echo "=========================================================================="
echo ""

# Print build artifact info
echo "Build Artifacts:"
echo "  - IssuerRegistry WASM: target/wasm32v1-none/release/issuer_registry.wasm"
echo "  - CredentialVerifier WASM: target/wasm32v1-none/release/credential_verifier.wasm"
echo ""

# Print next steps
echo "Next Steps:"
echo "  1. Review the implementation in the code"
echo "  2. Merge changes to main branch"
echo "  3. Deploy to testnet"
echo "  4. Run integration tests"
echo "  5. Deploy to mainnet"
echo ""

exit 0
