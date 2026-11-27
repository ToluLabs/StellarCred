## Summary

This PR fixes issue #905 where the dashboard could render stale credential data after a refresh due to a race condition in the query invalidation logic.

## Problem

The dashboard was showing stale credential data because network responses were returning after cache updates, causing the invalidation logic to not fully execute. The root cause was in the cross-tab sync mechanism where the request ID was incremented inside the debounced callback rather than immediately when the storage event fired.

### Race Condition Timeline (Before Fix)
```
t=0ms:    Storage Event Fires
          └─> Debounce timer starts (100ms)
          └─> requestId = N (unchanged) ❌

t=20ms:   User saves credential
          └─> requestId = N+1

t=100ms:  Debounce expires
          ├─> requestId = N+2 (incremented HERE - too late!)
          └─> loadCredentials() starts

t=150ms:  Stale data overwrites fresh state ❌
```

## Solution

### Core Fix - `useCredentialStore.ts`
- **Fixed race condition** by incrementing requestId **immediately** when storage event fires, not inside the debounced callback
- This ensures mutations during the 100ms debounce window properly invalidate delayed reloads
- Added detailed comments explaining the fix

### Secondary Fix - `CredentialExportPanel.tsx`  
- Added proper request sequencing with requestIdRef and isMountedRef
- Implemented storage event listener to sync with credential changes
- Prevents stale data from showing in the export panel

### Test Coverage - `useCredentialStore.test.ts`
- Added new test: "prevents stale data from cross-tab sync when mutations happen during debounce window"
- All 8 tests passing ✅

## Changes

- `frontend/lib/hooks/useCredentialStore.ts` - Core race condition fix (6 lines changed)
- `frontend/components/holder/CredentialExportPanel.tsx` - Request sequencing (39 lines added)
- `frontend/lib/hooks/useCredentialStore.test.ts` - New test coverage (46 lines added)

**Total: +88 insertions, -3 deletions**

## Testing

✅ All tests passing (8/8 in useCredentialStore.test.ts)
✅ No TypeScript compilation errors
✅ Verified fix resolves the race condition
✅ Manual testing confirmed stale data no longer appears

## Expected Behavior After Fix

✅ Dashboard always reflects the most recent credential state after refreshes
✅ Cache updates are properly respected during network responses  
✅ User-triggered re-fetches don't overwrite optimistic updates
✅ Cross-tab sync properly invalidates stale reloads
✅ Export panel stays synchronized with credential changes

## Closes

Closes #905
