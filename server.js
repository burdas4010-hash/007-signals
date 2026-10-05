
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '007boss';

// База данных в JSON-файле (чтобы не упасть на Render)
const DB_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) {
        console.error("Ошибка чтения БД:", e);
    }
    return {};
}

function saveUsers(users) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
    } catch (e) {
        console.error("Ошибка записи БД:", e);
    }
}

let usersDB = loadUsers(); // Формат: { "1234567": { uid: "1234567", status: "approved", date: "..." } }

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// 1. Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. Проверка UID пользователем с фронтенда
app.get('/api/verify-uid', (req, res) => {
    const uid = req.query.uid;
    if (!uid) {
        return res.json({ status: 'rejected', message: 'UID не указан' });
    }

    const user = usersDB[uid];
    if (user) {
        return res.json({ status: user.status, uid: user.uid });
    } else {
        return res.json({ status: 'pending', message: 'UID не найден или ожидает депозита' });
    }
});

// 3. Прием Postback от Pocket Option (PocketPartners)
app.all('/api/postback/pocketoption', (req, res) => {
    const data = { ...req.query, ...req.body };
    console.log("Получен Postback:", data);

    const uid = data.uid || data.sub_id || data.user_id || data.trader_id;
    const eventType = data.event || data.type || 'registration';

    if (uid) {
        usersDB[uid] = {
            uid: String(uid),
            status: 'approved', // Автоматически подтверждаем при получении постбэка
            event: eventType,
            updatedAt: new Date().toISOString()
        };
        saveUsers(usersDB);
        console.log(`UID ${uid} успешно активирован!`);
    }

    res.status(200).send('OK');
});

// 4. Админ-панель: получение списка всех UID
app.get('/api/admin/users', (req, res) => {
    const token = req.headers['x-admin-token'] || req.query.token;
    if (token !== ADMIN_TOKEN) {
        return res.status(403).json({ error: 'Доступ запрещен' });
    }
    res.json(Object.values(usersDB));
});

// 5. Админ-панель: ручное изменение статуса UID (Approve / Reject)
app.post('/api/admin/update-status', (req, res) => {
    const { token, uid, status } = req.body;
    if (token !== ADMIN_TOKEN) {
        return res.status(403).json({ error: 'Доступ запрещен' });
    }

    if (uid) {
        usersDB[uid] = {
            uid: String(uid),
            status: status || 'approved',
            updatedAt: new Date().toISOString()
        };
        saveUsers(usersDB);
        return res.json({ success: true, user: usersDB[uid] });
    }

    res.status(400).json({ error: 'Неверный UID' });
});

app.listen(PORT, () => {
    console.log(`Сервер 007 Signals запущен на порту ${PORT}`);
});
