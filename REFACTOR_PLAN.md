# 會話架構重構計劃

## 新架構設計

### 核心理念
- **所有會話都是文件**（包括活躍會話）
- **狀態驅動**：ACTIVE 或 END
- **統一數據結構**：所有會話格式相同

### 數據結構
```javascript
{
  id: "session_123456",
  name: "Session Name",
  createdAt: "2026-03-07T03:00:00Z",
  status: "ACTIVE", // or "END"
  endedAt: null, // or "2026-03-07T04:00:00Z"
  
  // 用戶數據
  users: [
    {
      name: "User A",
      color: "#FF0000",
      path: [{lat, lng, timestamp}],
      lastOnline: "2026-03-07T03:05:00Z"
    }
  ],
  
  // 當前在線用戶（socket IDs）
  onlineUsers: {
    "socket_id_1": "User A",
    "socket_id_2": "User B"
  },
  
  // 標記和消息
  markers: [...],
  messages: [...]
}
```

### 文件存儲
```
sessions/
  ├─ session_123456.json  (ACTIVE)
  ├─ session_789012.json  (ACTIVE)
  └─ ended/
      ├─ session_2026-03-06_15-30-00_Name.json
      └─ session_2026-03-06_16-00-00_Name.json
```

### 工作流程

**1. 服務器啟動**
```javascript
// 讀取所有會話文件
loadAllSessions() {
  // 讀取 sessions/*.json
  // 讀取 sessions/ended/*.json
  // 恢復到 sessions Map
}
```

**2. 創建會話**
```javascript
createSession(name) {
  const session = {
    id: generateId(),
    name,
    status: "ACTIVE",
    users: [],
    onlineUsers: {},
    markers: [],
    messages: []
  };
  
  // 立即保存到文件
  saveSession(session.id);
  
  return session;
}
```

**3. 加入會話**
```javascript
joinSession(socketId, sessionId, userName) {
  const session = sessions.get(sessionId);
  
  // 添加到在線用戶
  session.onlineUsers[socketId] = userName;
  
  // 如果是新用戶，添加到 users 列表
  if (!session.users.find(u => u.name === userName)) {
    session.users.push({
      name: userName,
      color: getNextColor(),
      path: [],
      lastOnline: new Date().toISOString()
    });
  }
  
  // 保存到文件
  saveSession(sessionId);
  
  // 廣播給該會話的在線用戶
  broadcastToSession(sessionId, 'users:update', session.users);
}
```

**4. 實時功能**
```javascript
// 用戶發送消息
addMessage(sessionId, message) {
  const session = sessions.get(sessionId);
  session.messages.push(message);
  saveSession(sessionId);
  broadcastToSession(sessionId, 'message:new', message);
}

// 用戶添加標記
addMarker(sessionId, marker) {
  const session = sessions.get(sessionId);
  session.markers.push(marker);
  saveSession(sessionId);
  broadcastToSession(sessionId, 'marker:added', marker);
}

// 用戶更新位置
updatePosition(socketId, position) {
  const sessionId = userSessions.get(socketId);
  const session = sessions.get(sessionId);
  const userName = session.onlineUsers[socketId];
  
  const user = session.users.find(u => u.name === userName);
  if (user && user.tracking) {
    user.path.push(position);
    saveSession(sessionId);
  }
  
  broadcastToSession(sessionId, 'user:position', {userName, position});
}
```

**5. 結束會話**
```javascript
endSession(sessionId) {
  const session = sessions.get(sessionId);
  
  // 更新狀態
  session.status = "END";
  session.endedAt = new Date().toISOString();
  
  // 移動到 ended 文件夾
  const filename = `session_${formatDate(session.endedAt)}_${session.name}.json`;
  fs.renameSync(
    `sessions/${sessionId}.json`,
    `sessions/ended/${filename}`
  );
  
  // 從內存移除
  sessions.delete(sessionId);
  
  // 通知所有在線用戶
  broadcastToSession(sessionId, 'session:ended', {sessionId, filename});
}
```

**6. 廣播功能**
```javascript
broadcastToSession(sessionId, event, data) {
  const session = sessions.get(sessionId);
  if (!session) return;
  
  // 只發送給該會話的在線用戶
  Object.keys(session.onlineUsers).forEach(socketId => {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit(event, data);
    }
  });
}
```

### 前端邏輯

**1. 初始化**
```javascript
async function init() {
  // 獲取活躍會話
  const activeSessions = await fetch('/api/sessions?status=ACTIVE');
  
  // 顯示活躍會話列表
  displayActiveSessions(activeSessions);
}
```

**2. 加入會話**
```javascript
function joinSession(sessionId) {
  // 發送加入請求
  socket.emit('session:join', {sessionId, userName});
  
  // 接收會話數據
  socket.on('session:data', (session) => {
    // 顯示用戶列表
    displayUsers(session.users);
    
    // 顯示標記
    displayMarkers(session.markers);
    
    // 顯示消息
    displayMessages(session.messages);
  });
}
```

**3. 實時更新**
```javascript
// 接收新消息
socket.on('message:new', (message) => {
  addMessageToUI(message);
});

// 接收新標記
socket.on('marker:added', (marker) => {
  addMarkerToMap(marker);
});

// 接收用戶位置更新
socket.on('user:position', (data) => {
  updateUserPosition(data.userName, data.position);
});
```

### API 端點

```
GET  /api/sessions?status=ACTIVE    # 獲取活躍會話
GET  /api/sessions?status=END       # 獲取已結束會話
GET  /api/sessions/:id              # 獲取會話詳情
POST /api/sessions                   # 創建會話
PUT  /api/sessions/:id/end          # 結束會話
```

### 優勢

1. **簡單明確** - 所有會話都是文件
2. **持久化** - 服務器重啟不丟失數據
3. **狀態清晰** - ACTIVE/END 明確區分
4. **易於調試** - 可以直接查看文件內容
5. **會話隔離** - 每個會話有自己的在線用戶列表

### 實時功能處理

**在線用戶跟踪：**
- `session.onlineUsers` - Map of socketId → userName
- 用戶連接時添加
- 用戶斷線時移除
- 實時更新給會話內所有用戶

**消息和標記：**
- 實時廣播給會話內所有在線用戶
- 同時保存到文件

**用戶路徑：**
- 實時更新
- 定期保存到文件（每 30 秒）

