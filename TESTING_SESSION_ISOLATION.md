# Session Isolation Testing Guide

## Problem Fixed
Users from different sessions were seeing each other. Now each session is completely isolated.

## Test Scenarios

### Test 1: Basic Session Isolation
```
1. User A creates Session A
2. User B creates Session B (different browser/incognito)
3. ✅ User A should only see User A in users list
4. ✅ User B should only see User B in users list
5. ✅ No cross-session visibility
```

### Test 2: Join Existing Session
```
1. User A creates Session A
2. User B joins Session A (via Active Sessions list)
3. ✅ Both users see each other in users list
4. ✅ Session name shows in top right corner
5. ✅ Start time shows in top right corner
```

### Test 3: Multi-Session Scenario (Your Bug Report)
```
1. User A creates Session A
2. User B joins Session A
3. Both disconnect (close browser)
4. User B refreshes and creates Session B
5. User A refreshes and joins Session A
6. ✅ User A should NOT see User B
7. ✅ User A only sees users in Session A
8. ✅ User B only sees users in Session B
```

### Test 4: UI Display
```
1. Create or join a session
2. ✅ Top right corner should show:
   - Session name
   - Started: [date/time]
   - Users: [count]
3. ✅ Users list in sidebar should match session
```

## What Was Fixed

### Backend (server.js)
1. **Event Order**: session:join must come before user:join
2. **Session Assignment**: user:join checks userSessions before auto-assigning
3. **Broadcasting**: Only broadcast to users in the same session
4. **Logging**: Added debug logs to track session assignments

### Frontend (public/index.html)
1. **Event Order**: joinSpecificSession sends session:join first
2. **Wait for Creation**: joinSession waits for session:created event
3. **UI Updates**: session:joined updates session info display
4. **Helper Function**: Added joinSessionWithPosition for cleaner code

## How Sessions Work Now

### Session Lifecycle
```
1. Create Session → sessions.set(id, session)
2. User joins → userSessions.set(socketId, sessionId)
3. Broadcasts → Only to users in session.users
4. User leaves → Remove from session.users
5. End Session → Save to file, delete from memory
```

### Data Isolation
- Each session has its own users Map
- Each session has its own markers Map
- Each session has its own messages array
- Broadcasts only go to session members

## Debugging

### Check Server Logs
```bash
pm2 logs collaborative-map --lines 50
```

Look for:
- "User X joining session Y"
- "Session not found: undefined" (should not appear)
- "User joined: X (color) with Y path points"

### Check Browser Console
Open DevTools → Console

Look for:
- "Session created, now joining: X"
- "Joined session: X"
- Any errors about session not found

### Check Network Tab
Open DevTools → Network → WS (WebSocket)

Look for:
- session:join event
- user:join event
- users:update event (should only show users in your session)

## Common Issues

### Issue: Seeing users from other sessions
**Cause**: Wrong event order or session not set before user:join
**Fix**: Clear cache (Ctrl+Shift+Delete), hard refresh (Ctrl+Shift+R)

### Issue: Session name not showing
**Cause**: session:joined not received or UI not updated
**Fix**: Check browser console for errors

### Issue: Users list shows wrong users
**Cause**: Broadcasting to all users instead of session members
**Fix**: Ensure broadcastUsers(sessionId) is called with sessionId

## Success Criteria

✅ Users in Session A cannot see users in Session B
✅ Markers are session-specific
✅ Messages are session-specific
✅ Session name displays in UI
✅ Start time displays in UI
✅ User count is accurate
✅ No "Session not found: undefined" errors

## Commit
- **Hash**: d2328cd
- **Date**: 2026-03-07
- **Message**: "fix: critical session isolation and UI issues"
