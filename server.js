const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());
// В начале файла, после импортов, обновите CORS настройки:
app.use(cors({
    origin: function(origin, callback) {
        // Разрешаем все origins в development
        if (process.env.NODE_ENV !== 'production') {
            callback(null, true);
        } else {
            // В production можно ограничить origins
            callback(null, true);
        }
    },
    credentials: true
}));

// Простая база данных в памяти (имитация Firebase Realtime Database)
class SimpleDatabase {
    constructor() {
        this.data = {
            users: {},
            transactions: []
        };
        this.listeners = {};
    }
    
    // Получить данные по пути
    get(path) {
        const keys = path.split('/').filter(k => k);
        let current = this.data;
        
        for (const key of keys) {
            if (current && typeof current === 'object') {
                current = current[key];
            } else {
                return null;
            }
        }
        
        return current;
    }
    
    // Установить данные по пути
    set(path, value) {
        const keys = path.split('/').filter(k => k);
        let current = this.data;
        
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (!current[key] || typeof current[key] !== 'object') {
                current[key] = {};
            }
            current = current[key];
        }
        
        const lastKey = keys[keys.length - 1];
        const oldValue = current[lastKey];
        current[lastKey] = value;
        
        // Уведомляем слушателей об изменении
        this.notifyListeners(path, value, oldValue);
        
        return true;
    }
    
    // Обновить данные (merge)
    update(path, updates) {
        const keys = path.split('/').filter(k => k);
        let current = this.data;
        
        for (const key of keys) {
            if (!current[key] || typeof current[key] !== 'object') {
                current[key] = {};
            }
            current = current[key];
        }
        
        const oldValue = { ...current };
        Object.assign(current, updates);
        
        this.notifyListeners(path, current, oldValue);
        
        return true;
    }
    
    // Добавить слушателя изменений
    on(path, callback) {
        if (!this.listeners[path]) {
            this.listeners[path] = [];
        }
        this.listeners[path].push(callback);
    }
    
    // Убрать слушателя
    off(path, callback) {
        if (this.listeners[path]) {
            const index = this.listeners[path].indexOf(callback);
            if (index > -1) {
                this.listeners[path].splice(index, 1);
            }
        }
    }
    
    // Уведомить слушателей
    notifyListeners(path, newValue, oldValue) {
        // Уведомляем точных слушателей
        if (this.listeners[path]) {
            this.listeners[path].forEach(callback => {
                callback(newValue, oldValue, path);
            });
        }
        
        // Уведомляем родительских слушателей
        const pathParts = path.split('/').filter(k => k);
        for (let i = pathParts.length - 1; i > 0; i--) {
            const parentPath = pathParts.slice(0, i).join('/');
            if (this.listeners[parentPath]) {
                const parentData = this.get(parentPath);
                this.listeners[parentPath].forEach(callback => {
                    callback(parentData, null, parentPath);
                });
            }
        }
    }
    
    // Транзакция (атомарная операция)
    transaction(path, updateFunction) {
        const currentValue = this.get(path);
        const newValue = updateFunction(currentValue);
        this.set(path, newValue);
        return newValue;
    }
}

const db = new SimpleDatabase();

// Инициализация начальных данных
console.log('🚀 Инициализация базы данных...');
console.log('qr version');

// API Routes

// Получить баланс пользователя
app.get('/api/balance/:userId', (req, res) => {
    const userId = String(req.params.userId);
    
    const user = db.get(`users/${userId}`);
    const balance = user ? user.balance || 0 : 0;
    
    // Если пользователь новый, создаем его
    if (!user) {
        db.set(`users/${userId}`, {
            id: userId,
            balance: 0,
            createdAt: new Date().toISOString()
        });
    }
    
    console.log(`📊 Запрос баланса для ${userId}: ${balance} ₽`);
    
    res.json({
        success: true,
        balance: balance,
        userId: userId
    });
});

// Пополнить баланс
app.post('/api/topup', (req, res) => {
    const { userId, amount } = req.body;
    
    if (!userId || !amount || amount < 100 || amount > 5000) {
        return res.status(400).json({
            success: false,
            error: 'Некорректные данные'
        });
    }
    
    // Получаем текущий баланс
    const currentUser = db.get(`users/${userId}`) || { balance: 0 };
    const newBalance = (currentUser.balance || 0) + amount;
    
    // Обновляем баланс пользователя
    db.update(`users/${userId}`, {
        id: userId,
        balance: newBalance,
        lastTopup: new Date().toISOString()
    });
    
    // Добавляем транзакцию
    const transaction = {
        id: 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        userId: userId,
        type: 'topup',
        amount: amount,
        timestamp: new Date().toISOString(),
        description: `Пополнение на ${amount} ₽`
    };
    
    const transactions = db.get('transactions') || [];
    transactions.push(transaction);
    db.set('transactions', transactions);
    
    console.log(`💰 Пополнение для ${userId}: +${amount} ₽ (новый баланс: ${newBalance} ₽)`);
    
    // Уведомляем всех подключенных клиентов через WebSocket
    io.emit('balance_updated', {
        userId: userId,
        balance: newBalance,
        transaction: transaction
    });
    
    res.json({
        success: true,
        balance: newBalance,
        transaction: transaction
    });
});

// Получить историю транзакций
app.get('/api/transactions/:userId', (req, res) => {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    
    const allTransactions = db.get('transactions') || [];
    const userTransactions = allTransactions
        .filter(tx => tx.userId === userId)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, limit);
    
    res.json({
        success: true,
        transactions: userTransactions
    });
});

// Получить информацию о сервере
app.get('/api/status', (req, res) => {
    const usersCount = Object.keys(db.get('users') || {}).length;
    const transactionsCount = (db.get('transactions') || []).length;
    
    res.json({
        status: 'running',
        uptime: process.uptime(),
        users: usersCount,
        transactions: transactionsCount,
        timestamp: new Date().toISOString()
    });
});

// Новый эндпоинт: Получить список онлайн-пользователей
app.get('/api/users/online', (req, res) => {
    try {
        const onlineUsers = [];
        const sockets = io.sockets.sockets;
        
        // Собираем уникальных пользователей
        const usersMap = new Map();
        
        sockets.forEach(socket => {
            if (socket.userId) { // Проверяем, что userId есть
                usersMap.set(socket.userId, {
                    userId: socket.userId,
                    lastSeen: new Date().toISOString()
                });
            }
        });
        
        // Преобразуем Map в массив
        const uniqueUsers = Array.from(usersMap.values());
        
        console.log(`👥 Запрос списка онлайн-пользователей: ${uniqueUsers.length} пользователей`);
        
        res.json({
            success: true,
            count: uniqueUsers.length,
            users: uniqueUsers
        });
    } catch (error) {
        console.error('Ошибка при получении онлайн-пользователей:', error);
        res.status(500).json({
            success: false,
            error: 'Ошибка сервера'
        });
    }
});

// Новый эндпоинт: Перевод между пользователями
app.post('/api/transfer', (req, res) => {
    const { fromUserId, toUserId, amount, description = '' } = req.body;
    
    // Валидация данных
    if (!fromUserId || !toUserId || !amount) {
        return res.status(400).json({
            success: false,
            error: 'Не указаны обязательные параметры'
        });
    }
    
    if (fromUserId === toUserId) {
        return res.status(400).json({
            success: false,
            error: 'Нельзя переводить самому себе'
        });
    }
    
    if (amount < 100 || amount > 5000) {
        return res.status(400).json({
            success: false,
            error: 'Сумма перевода должна быть от 100 до 5000 ₽'
        });
    }
    
    try {
        // Получаем данные отправителя
        const fromUser = db.get(`users/${fromUserId}`) || { balance: 0 };
        
        // Проверяем достаточность средств
        if (fromUser.balance < amount) {
            return res.status(400).json({
                success: false,
                error: 'Недостаточно средств на счете'
            });
        }
        
        // Получаем данные получателя (создаем если не существует)
        let toUser = db.get(`users/${toUserId}`);
        if (!toUser) {
            db.set(`users/${toUserId}`, {
                id: toUserId,
                balance: 0,
                createdAt: new Date().toISOString()
            });
            toUser = db.get(`users/${toUserId}`);
        }
        
        // Выполняем атомарную транзакцию
        db.transaction('users', (users) => {
            // Обновляем баланс отправителя
            users[fromUserId] = {
                ...users[fromUserId],
                balance: users[fromUserId].balance - amount
            };
            
            // Обновляем баланс получателя
            users[toUserId] = {
                ...users[toUserId],
                balance: (users[toUserId]?.balance || 0) + amount
            };
            
            return users;
        });
        
    const transactions = db.get('transactions') || [];
    
    // Транзакция для отправителя (списание)
    const outTransaction = {
        id: 'tx_' + Date.now() + '_out_' + Math.random().toString(36).substr(2, 5),
        userId: fromUserId,
        relatedUserId: toUserId,
        type: 'transfer_out',
        amount: -amount,
        timestamp: new Date().toISOString(),
        description: description || `Перевод пользователю ${toUserId}`
    };
    transactions.push(outTransaction);
    
    // Транзакция для получателя (зачисление)
    const inTransaction = {
        id: 'tx_' + Date.now() + '_in_' + Math.random().toString(36).substr(2, 5),
        userId: toUserId,
        relatedUserId: fromUserId,
        type: 'transfer_in',
        amount: amount,
        timestamp: new Date().toISOString(),
        description: description || `Перевод от пользователя ${fromUserId}`
    };
    transactions.push(inTransaction);
    
    db.set('transactions', transactions);
    
    // Получаем актуальные балансы
    const updatedFromUser = db.get(`users/${fromUserId}`);
    const updatedToUser = db.get(`users/${toUserId}`);
    
    console.log(`↔️ Перевод ${fromUserId} -> ${toUserId}: ${amount} ₽`);
    
    // Отправляем уведомления через WebSocket с полной информацией
    io.to(fromUserId).emit('balance_updated', {
        userId: fromUserId,
        balance: updatedFromUser.balance,
        transaction: outTransaction // отправляем полную транзакцию
    });
    
    io.to(toUserId).emit('balance_updated', {
        userId: toUserId,
        balance: updatedToUser.balance,
        transaction: inTransaction // отправляем полную транзакцию
    });
        
        res.json({
            success: true,
            fromUserId: fromUserId,
            toUserId: toUserId,
            amount: amount,
            newBalanceFrom: updatedFromUser.balance,
            newBalanceTo: updatedToUser.balance
        });
        
    } catch (error) {
        console.error('Ошибка при переводе средств:', error);
        res.status(500).json({
            success: false,
            error: 'Ошибка при выполнении перевода'
        });
    }
});

app.post('/api/payment', (req, res) => {
    // 1. ИСПРАВЛЕНИЕ: Достаем kassaId из тела запроса
    const { fromUserId, storeName, amount, kassaId } = req.body;

    // 2. ИСПРАВЛЕНИЕ: Добавляем kassaId в проверку
    if (!fromUserId || !storeName || !amount || !kassaId) {
        return res.status(400).json({ success: false, error: 'Не указаны обязательные параметры (включая kassaId)' });
    }
    if (amount <= 0) {
        return res.status(400).json({ success: false, error: 'Сумма должна быть положительной' });
    }

    try {
        const fromUser = db.get(`users/${fromUserId}`);
        if (!fromUser || fromUser.balance < amount) {
            return res.status(400).json({ success: false, error: 'Недостаточно средств' });
        }

        const newBalance = db.transaction(`users/${fromUserId}/balance`, (currentBalance) => {
            return (currentBalance || 0) - amount;
        });

        const transaction = {
            id: 'tx_' + Date.now() + '_qr_' + Math.random().toString(36).substr(2, 5),
            userId: fromUserId,
            type: 'qr_payment',
            amount: -amount,
            timestamp: new Date().toISOString(),
            description: `Оплата в "${storeName}" (Касса: ${kassaId})`
        };
        const transactions = db.get('transactions') || [];
        transactions.push(transaction);
        db.set('transactions', transactions);

        console.log(`🔳 QR-оплата от ${fromUserId} в "${storeName}": ${amount} ₽`);

        // Теперь переменная kassaId существует и здесь всё сработает
        console.log(`📢 Отправка подтверждения на кассу с ID: ${kassaId}`);
        io.to(kassaId).emit('payment_successful', { 
            status: 'ok',
            amount: amount,
            userId: fromUserId,
            transactionId: transaction.id 
        });

        // Уведомляем и самого клиента об изменении баланса
        io.to(fromUserId).emit('balance_updated', {
            userId: fromUserId,
            balance: newBalance,
            transaction: transaction
        });

        // Отвечаем мобильному приложению, что все прошло успешно
        res.json({
            success: true,
            newBalance: newBalance,
            transaction: transaction
        });

    } catch (error) {
        console.error('Ошибка при QR-оплате:', error);
        res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера' });
    }
});


// WebSocket обработчики
io.on('connection', (socket) => {
    console.log(`🔌 Новое подключение: ${socket.id}`);
    
    // Этот обработчик теперь используется и кассой, и клиентами
    socket.on('join', (id) => {
        // Сохраняем id в объекте сокета
        socket.userId = id;
        socket.join(id); // <--- КЛЮЧЕВАЯ КОМАНДА
        console.log(`👤 Пользователь или касса с ID [${id}] присоединился к своей комнате`);
        
        // Если это обычный пользователь, отправляем ему баланс
        const user = db.get(`users/${id}`);
        if (user) {
            socket.emit('balance_updated', {
                userId: id,
                balance: user.balance || 0
            });
        }
    });
	
    socket.on('disconnect', () => {
        console.log(`🔌 Отключение: ${socket.id}`);
    });
});

// Настройка слушателей базы данных (имитация Firebase Realtime Database)
db.on('users', (userData) => {
    console.log('📡 Данные пользователей обновлены:', Object.keys(userData || {}).length, 'пользователей');
});

db.on('transactions', (transactions) => {
    console.log('📡 Транзакции обновлены:', (transactions || []).length, 'транзакций');
});

// Обработка ошибок
app.use((err, req, res, next) => {
    console.error('❌ Ошибка сервера:', err);
    res.status(err.status || 500).json({
        success: false,
        error: 'Внутренняя ошибка сервера'
    });
});

// 404 обработчик
app.use((req, res, next) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint не найден'
    });
});

const PORT = process.env.PORT || 3001;

// Получаем IP-адрес в локальной сети
function getLocalIP() {
    const interfaces = require('os').networkInterfaces();
    for (const interfaceName in interfaces) {
        for (const iface of interfaces[interfaceName]) {
            // Пропускаем внутренние и не-IPv4 адреса
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const LOCAL_IP = getLocalIP();

server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('🏦 ================================');
    console.log('🏦 СБЕРBANK API СЕРВЕР ЗАПУЩЕН');
    console.log('🏦 ================================');
    console.log(`🌍 Локальный адрес: http://localhost:${PORT}`);
    console.log(`🌐 Сетевой адрес: http://${LOCAL_IP}:${PORT}`);
    console.log(`📡 API: http://${LOCAL_IP}:${PORT}/api`);
    console.log(`📊 Статус: http://${LOCAL_IP}:${PORT}/api/status`);
    console.log('🔌 WebSocket: активен');
    console.log('💾 База данных: в памяти (SimpleDB)');
    console.log('🏦 ================================');
    console.log('');
});


// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Завершение работы сервера...');
    server.close(() => {
        console.log('✅ Сервер остановлен');
        process.exit(0);
    });
});


