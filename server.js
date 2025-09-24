const { WebSocketServer, WebSocket } = require('ws');
const { createServer } = require('http');
const { v4: uuidv4 } = require('uuid');

class VoxiServer {
    constructor(port = process.env.PORT || 8080) {
        this.users = new Map();
        this.messages = [];
        this.typingStatus = new Map();
        
        const server = createServer();
        this.wss = new WebSocketServer({ server });
        
        this.wss.on('connection', this.handleConnection.bind(this));
        
        server.listen(port, '0.0.0.0', () => {
            console.log(`Voxi WebSocket Server running on port ${port}`);
        });

        // Keep alive ping
        setInterval(() => {
            this.wss.clients.forEach(ws => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                }
            });
        }, 30000);

        // Cleanup
        setInterval(() => this.cleanupConnections(), 30000);
    }

    handleConnection(ws) {
        console.log('New connection established');
        let userId = null;

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                
                switch (message.type) {
                    case 'auth':
                        userId = this.handleAuth(ws, message.payload);
                        break;
                    case 'message':
                        if (userId) {
                            this.handleMessage(userId, message.payload);
                        }
                        break;
                    case 'typing':
                        if (userId) {
                            this.handleTyping(userId, message.payload);
                        }
                        break;
                    case 'read':
                        if (userId) {
                            this.handleRead(userId, message.payload);
                        }
                        break;
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        });

        ws.on('close', () => {
            if (userId) {
                this.handleDisconnect(userId);
            }
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });

        ws.on('pong', () => {
            if (userId && this.users.has(userId)) {
                this.users.get(userId).lastSeen = new Date();
            }
        });
    }

    handleAuth(ws, payload) {
        if (!payload || !payload.username || payload.username.trim() === '') {
            ws.send(JSON.stringify({
                type: 'error',
                payload: { message: 'Invalid username' }
            }));
            ws.close();
            return '';
        }

        const userId = payload.userId || uuidv4();
        const user = {
            id: userId,
            username: payload.username.trim(),
            ws,
            online: true,
            lastSeen: new Date()
        };

        this.users.set(userId, user);
        
        ws.send(JSON.stringify({
            type: 'auth',
            payload: {
                success: true,
                userId,
                username: payload.username
            }
        }));

        this.broadcastUserList();
        this.sendMessageHistory(userId);
        this.broadcastUserStatus(userId, true);

        console.log(`User ${payload.username} (${userId}) connected`);
        return userId;
    }

    handleMessage(fromUserId, payload) {
        const fromUser = this.users.get(fromUserId);
        if (!fromUser) return;

        const message = {
            id: uuidv4(),
            from: fromUserId,
            to: payload.to,
            content: payload.content,
            timestamp: new Date(),
            type: payload.type || 'text',
            delivered: false,
            read: false
        };

        this.messages.push(message);

        const toUser = this.users.get(payload.to);
        if (toUser && toUser.ws.readyState === WebSocket.OPEN) {
            toUser.ws.send(JSON.stringify({
                type: 'message',
                payload: {
                    ...message,
                    fromUsername: fromUser.username
                }
            }));
            message.delivered = true;

            fromUser.ws.send(JSON.stringify({
                type: 'delivered',
                payload: {
                    messageId: message.id,
                    to: payload.to
                }
            }));
        }

        fromUser.ws.send(JSON.stringify({
            type: 'message',
            payload: {
                ...message,
                sent: true
            }
        }));
    }

    handleTyping(userId, payload) {
        const toUser = this.users.get(payload.to);
        const fromUser = this.users.get(userId);
        
        if (toUser && fromUser && toUser.ws.readyState === WebSocket.OPEN) {
            toUser.ws.send(JSON.stringify({
                type: 'typing',
                payload: {
                    from: userId,
                    username: fromUser.username,
                    typing: payload.typing
                }
            }));
        }
    }

    handleRead(userId, payload) {
        this.messages.forEach(msg => {
            if (payload.messageIds.includes(msg.id)) {
                msg.read = true;
            }
        });

        const fromUser = this.users.get(payload.from);
        if (fromUser && fromUser.ws.readyState === WebSocket.OPEN) {
            fromUser.ws.send(JSON.stringify({
                type: 'read',
                payload: {
                    messageIds: payload.messageIds,
                    by: userId
                }
            }));
        }
    }

    handleDisconnect(userId) {
        const user = this.users.get(userId);
        if (user) {
            user.online = false;
            user.lastSeen = new Date();
            this.broadcastUserStatus(userId, false);
            this.broadcastUserList();
            console.log(`User ${user.username} (${userId}) disconnected`);
        }
    }

    broadcastUserList() {
        const userList = Array.from(this.users.values()).map(user => ({
            id: user.id,
            username: user.username,
            online: user.online,
            lastSeen: user.lastSeen
        }));

        this.broadcast({
            type: 'userList',
            payload: { users: userList }
        });
    }

    broadcastUserStatus(userId, online) {
        const user = this.users.get(userId);
        if (!user) return;

        this.broadcast({
            type: 'status',
            payload: {
                userId,
                username: user.username,
                online,
                lastSeen: user.lastSeen
            }
        }, userId);
    }

    sendMessageHistory(userId) {
        const user = this.users.get(userId);
        if (!user || user.ws.readyState !== WebSocket.OPEN) return;

        const userMessages = this.messages.filter(
            msg => msg.from === userId || msg.to === userId
        );

        user.ws.send(JSON.stringify({
            type: 'history',
            payload: { messages: userMessages }
        }));
    }

    broadcast(message, excludeUserId) {
        const data = JSON.stringify(message);
        
        this.users.forEach((user, userId) => {
            if (userId !== excludeUserId && user.ws.readyState === WebSocket.OPEN) {
                user.ws.send(data);
            }
        });
    }

    cleanupConnections() {
        this.users.forEach((user, userId) => {
            if (user.ws.readyState !== WebSocket.OPEN) {
                this.handleDisconnect(userId);
                this.users.delete(userId);
            }
        });
    }
}

// Start server
const server = new VoxiServer();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down Voxi Server...');
    process.exit(0);
});