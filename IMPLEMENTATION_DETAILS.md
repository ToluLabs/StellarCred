# Implementation Details - Admin Rotation (Issue #342)

## Quick Reference

### Modified Files
1. `contracts/issuer_registry/src/lib.rs`
2. `contracts/issuer_registry/src/test.rs`
3. `contracts/credential_verifier/src/lib.rs`
4. `contracts/credential_verifier/src/test.rs`

### Line-by-Line Changes

## IssuerRegistry

### contracts/issuer_registry/src/lib.rs

**EventAdminChanged struct** (Lines 61-70)
```rust
/// Payload emitted when the admin is changed.
/// Topics: ("iss_reg", "admin_changed")
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventAdminChanged {
    /// The address of the previous admin.
    pub old_admin: Address,
    /// The address of the new admin.
    pub new_admin: Address,
    /// Timestamp when the change occurred.
    pub changed_at: u64,
}
```

**set_admin() function** (Lines 376-412)
```rust
/// Transfer the root admin to `new_admin`. Root-admin only.
///
/// This is a wholesale governance transfer: the `Admin` key and every role
/// currently held by the old root admin move to `new_admin`, so the old
/// root loses all privileged access exactly as it did before roles existed.
/// Fine-grained delegation afterwards uses `grant_role` / `revoke_role`.
/// Emits an `admin_changed` event with the transition details.
#[allow(deprecated)]
pub fn set_admin(env: Env, new_admin: Address) {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
    admin.require_auth();

    let mut roles: Map<Symbol, Address> = Self::roles(&env);
    for (role, holder) in roles.iter() {
        if holder == admin {
            roles.set(role, new_admin.clone());
        }
    }
    env.storage().instance().set(&DataKey::Roles, &roles);
    env.storage().instance().set(&DataKey::Admin, &new_admin);

    // Emit: topics = ("iss_reg", "admin_changed")
    //       data   = EventAdminChanged { old_admin, new_admin, changed_at }
    env.events().publish(
        (symbol_short!("iss_reg"), symbol_short!("admin_changed")),
        EventAdminChanged {
            old_admin: admin,
            new_admin,
            changed_at: env.ledger().timestamp(),
        },
    );
}
```

### contracts/issuer_registry/src/test.rs

**Test functions** (Lines 795-945)

1. **admin_can_transfer_to_new_admin** (Lines 797-818)
   - Verifies admin() returns correct address before and after transfer
   - Verifies admin role ownership changes

2. **admin_transfer_moves_roles_to_new_admin** (Lines 820-836)
   - Similar to above, emphasizing role transfer

3. **only_current_admin_can_rotate** (Lines 839-859)
   - Tests authorization rejection for non-admin
   - Uses try_set_admin for error checking

4. **post_rotation_new_admin_can_perform_ops** (Lines 862-890)
   - Registers issuer after admin rotation
   - Verifies new admin has register capability

5. **post_rotation_old_admin_cannot_perform_ops** (Lines 892-919)
   - Attempts issuer registration with old admin
   - Verifies operation fails with .is_err() assertion

6. **set_admin_emits_expected_event** (Lines 921-945)
   - Validates event topics: ("iss_reg", "admin_changed")
   - Validates event data: old_admin, new_admin, changed_at > 0
   - Uses EventAdminChanged::try_from_val for type safety

---

## CredentialVerifier

### contracts/credential_verifier/src/lib.rs

**EventAdminChanged struct** (Lines 68-77)
```rust
/// Payload emitted when the admin is changed.
/// Topics: ("cred_ver", "admin_changed")
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventAdminChanged {
    /// The address of the previous admin.
    pub old_admin: Address,
    /// The address of the new admin.
    pub new_admin: Address,
    /// Timestamp when the change occurred.
    pub changed_at: u64,
}
```

**admin() getter** (Lines 452-457)
```rust
/// Returns the root admin address.
pub fn admin(env: Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized))
}
```

**set_admin() function** (Lines 460-496)
```rust
/// Transfer the root admin to `new_admin`. Root-admin only.
///
/// This is a wholesale governance transfer: the `Admin` key and every role
/// currently held by the old root admin move to `new_admin`, so the old
/// root loses all privileged access exactly as it did before roles existed.
/// Fine-grained delegation afterwards uses `grant_role` / `revoke_role`.
/// Emits an `admin_changed` event with the transition details.
#[allow(deprecated)]
pub fn set_admin(env: Env, new_admin: Address) {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialized));
    admin.require_auth();

    let mut roles: Map<Symbol, Address> = Self::roles(&env);
    for (role, holder) in roles.iter() {
        if holder == admin {
            roles.set(role, new_admin.clone());
        }
    }
    env.storage().instance().set(&DataKey::Roles, &roles);
    env.storage().instance().set(&DataKey::Admin, &new_admin);

    // Emit: topics = ("cred_ver", "admin_changed")
    //       data   = EventAdminChanged { old_admin, new_admin, changed_at }
    env.events().publish(
        (symbol_short!("cred_ver"), symbol_short!("admin_changed")),
        EventAdminChanged {
            old_admin: admin,
            new_admin,
            changed_at: env.ledger().timestamp(),
        },
    );
}
```

### contracts/credential_verifier/src/test.rs

**Test functions** (Lines 943-1108)

1. **admin_can_transfer_to_new_admin** (Lines 944-966)
   - Identical pattern to IssuerRegistry
   - Uses admin() and has_role() assertions

2. **admin_transfer_moves_roles_to_new_admin** (Lines 969-987)
   - Identical pattern to IssuerRegistry

3. **only_current_admin_can_rotate** (Lines 990-1012)
   - Uses try_set_admin() for authorization test

4. **post_rotation_new_admin_can_perform_ops** (Lines 1015-1044)
   - Calls set_vk() after admin rotation
   - Verifies new admin can set verification keys
   - Checks get_latest_version() returns expected version

5. **post_rotation_old_admin_cannot_perform_ops** (Lines 1047-1075)
   - Attempts set_vk() with old admin
   - Verifies operation fails with try_set_vk().is_err()

6. **set_admin_emits_expected_event** (Lines 1079-1108)
   - Validates event topics: ("cred_ver", "admin_changed")
   - Identical event validation to IssuerRegistry

---

## Code Statistics

### Additions Summary

| Category | Count |
|----------|-------|
| EventAdminChanged structs | 2 |
| set_admin() functions | 2 |
| admin() getters (added) | 1 |
| Test functions | 12 |
| Total new lines of code | ~394 |

### Test Coverage Matrix

| Test Case | IssuerRegistry | CredentialVerifier | Status |
|-----------|----------------|--------------------|--------|
| Admin transfer | ✅ | ✅ | Complete |
| Role inheritance | ✅ | ✅ | Complete |
| Authorization | ✅ | ✅ | Complete |
| New admin capability | ✅ | ✅ | Complete |
| Old admin isolation | ✅ | ✅ | Complete |
| Event emission | ✅ | ✅ | Complete |

---

## Execution Flow Diagram

### set_admin() Function Flow

```
1. Load admin address from DataKey::Admin
   ├─ Panic if not initialized
   └─ Success: admin = Address

2. Require admin authentication
   ├─ Panic if not authenticated
   └─ Success: continue

3. Load roles map from DataKey::Roles
   └─ Success: roles = Map<Symbol, Address>

4. Iterate all roles
   └─ For each (role, holder)
      ├─ If holder == admin
      │  └─ Set new holder = new_admin
      └─ Else: skip (delegated roles untouched)

5. Update storage
   ├─ Set DataKey::Roles with updated map
   └─ Set DataKey::Admin with new_admin

6. Emit event
   └─ Publish admin_changed with:
      ├─ Topics: (contract, "admin_changed")
      ├─ Data: EventAdminChanged { old_admin, new_admin, changed_at }
      └─ Timestamp: env.ledger().timestamp()

7. Return (all changes committed)
```

---

## Key Properties Verified

✅ **Authorization**
- Only current admin can call set_admin (require_auth)
- Non-admin attempts are rejected

✅ **Role Transfer**
- All roles held by old admin transfer to new admin
- Delegated roles (held by others) remain unchanged
- New admin can perform all operations old admin could

✅ **Capability Isolation**
- Old admin loses all privileged capabilities after transfer
- New admin gains all privileged capabilities immediately

✅ **Event Emission**
- Events emitted with correct contract-specific topics
- Event data includes both addresses and timestamp
- Events are auditable and indexed

✅ **Atomicity**
- Both storage keys updated in single call
- No partial state transfers
- Consistent state guaranteed

---

## Compatibility Notes

### Backward Compatibility
- ✅ No breaking changes
- ✅ All existing functions unchanged
- ✅ All existing tests remain valid
- ✅ Deployment contracts continue to work

### Forward Compatibility
- ✅ Event format extensible if needed
- ✅ Admin rotation chain possible (admin → new_admin → next_admin)
- ✅ Compatible with future DAO implementations

---

## Testing Instructions

### Run All Contract Tests
```bash
cargo test --locked
```

### Run Specific Contract Tests
```bash
cargo test -p issuer_registry
cargo test -p credential_verifier
```

### Run Specific Admin Rotation Tests
```bash
cargo test admin_can_transfer_to_new_admin -- --nocapture
cargo test admin_transfer_moves_roles_to_new_admin -- --nocapture
cargo test only_current_admin_can_rotate -- --nocapture
cargo test post_rotation_new_admin_can_perform_ops -- --nocapture
cargo test post_rotation_old_admin_cannot_perform_ops -- --nocapture
cargo test set_admin_emits_expected_event -- --nocapture
```

---

## CI Pipeline Integration

The implementation integrates seamlessly with the existing CI pipeline:

**File:** `.github/workflows/ci.yml`
**Job:** `contracts` (line 45)
**Steps:**
1. Install Rust + wasm32v1-none target
2. Generate circuit fixtures
3. Build WASM artifacts: `cargo build --release --target wasm32v1-none --locked`
4. **Run tests (includes new tests):** `cargo test --locked`
5. Lint with clippy: `cargo clippy --all-targets -- -D warnings`

All new code passes clippy checks with -D warnings flag.

---

## References

### Pattern Source
- **File:** `contracts/proof_registry/src/lib.rs`
- **set_admin location:** Lines 343-361
- **Tests:** `contracts/proof_registry/src/test.rs` Lines 1589-1620

### Related Issues
- **Issue #342:** Admin rotation (THIS ISSUE)
- **Companion issue:** Two-step propose/accept pattern (mentioned but out of scope)

---

## Conclusion

The implementation is production-ready with:
- ✅ Complete functional coverage
- ✅ Comprehensive test coverage
- ✅ Proper error handling
- ✅ Event auditing
- ✅ No breaking changes
- ✅ CI/CD ready

Ready for deployment with `cargo test --locked` verification.

