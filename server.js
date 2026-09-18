require('dotenv').config();

const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const bodyParser = require('body-parser');
const moment = require('moment');

const app = express();

// 設定 EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 靜態資源
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Session
app.use(session({
    secret: 'secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// MySQL連線
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect(err => {
    if (err) throw err;
    console.log('Connected to MySQL!');
});

// Multer 設定上傳資料夾
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// 首頁
app.get('/', (req, res) => {
    if (req.session.loggedIn) {
        res.redirect('/home');
    } else if (req.session.adminLoggedIn) {
        res.redirect('/admin/dashboard');
    } else {
        res.redirect('/login');
    }
});

// 登入頁
app.get('/login', (req, res) => {
    res.render('login');
});

// 註冊頁 GET
app.get('/register', (req, res) => {
    res.render('register', { error: null });
});
// 註冊頁 POST
app.post('/register', upload.single('profilePicture'), (req, res) => {
    const { name, phoneNumber, email, password, bio } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 10);
    const profilePicture = req.file ? req.file.path.replace(/\\/g, '/') : 'uploads/default-avatar.png';

    if (email === 'admin@postgram.com') {
        return res.render('register', { error: 'This email is reserved for admin login only.' });
    }

    // 檢查電話是否重複
    db.query('SELECT * FROM User WHERE PhoneNumber = ?', [phoneNumber], (err, phoneResults) => {
        if (err) throw err;

        if (phoneResults.length > 0) {
            return res.render('register', { error: 'This phone number is already registered.' });
        }

        // 檢查 email 是否重複
        db.query('SELECT * FROM User WHERE Email = ?', [email], (err, emailResults) => {
            if (err) throw err;

            if (emailResults.length > 0) {
                return res.render('register', { error: 'This email is already registered.' });
            }

            // 通過所有檢查後插入資料
            db.query(
                'INSERT INTO User (Name, PhoneNumber, Email, Password, ProfilePicture, Bio) VALUES (?, ?, ?, ?, ?, ?)',
                [name, phoneNumber, email, hashedPassword, profilePicture, bio || null],
                (err) => {
                    if (err) throw err;
                    res.redirect('/login');
                }
            );
        });
    });
});



// 登入功能（整合 admin 與使用者）
app.post('/login', (req, res) => {
    const { email, password } = req.body;

    // Admin 登入
    if (email === 'admin@postgram.com' && password === 'admin') {
        req.session.adminLoggedIn = true;
        console.log("✅ Admin logged in!");
        return res.redirect('/admin/dashboard');
    }

    // 一般使用者
    db.query('SELECT * FROM User WHERE Email = ?', [email], (err, users) => {
        if (err) throw err;
        if (users.length > 0 && bcrypt.compareSync(password, users[0].Password)) {
            req.session.loggedIn = true;
            req.session.user = users[0];
            res.redirect('/home');
        } else {
            res.send('Invalid email or password');
        }
    });
});

// 使用者首頁
app.get('/home', (req, res) => {
    if (!req.session.loggedIn) return res.redirect('/login');

    db.query(`
        SELECT Post.*, User.Name, User.ProfilePicture,
        (SELECT COUNT(*) FROM Likes WHERE Likes.PostID = Post.PostID) AS LikeCount
        FROM Post
        JOIN User ON Post.UserID = User.UserID
        ORDER BY Post.Timestamp DESC
    `, (err, posts) => {
        if (err) throw err;

        db.query(`
            SELECT Comment.*, User.Name 
            FROM Comment 
            JOIN User ON Comment.UserID = User.UserID
        `, (err, comments) => {
            if (err) throw err;

            const formattedPosts = posts.map(p => ({
                ...p,
                formattedTime: moment(p.Timestamp).fromNow()
            }));

            const formattedComments = comments.map(c => ({
                ...c,
                formattedTime: moment(c.Timestamp).fromNow()
            }));

            res.render('home', {
                posts: formattedPosts,
                comments: formattedComments,
                user: req.session.user // ← 加這一行，讓 ejs 能取得目前登入的使用者
            });
            
        });
    });
});

// 建立貼文
app.get('/postCreate', (req, res) => {
    if (req.session.loggedIn) {
        res.render('postCreate');
    } else {
        res.redirect('/login');
    }
});
app.post('/createPost', upload.single('media'), (req, res) => {
    const { content } = req.body;
    const media = req.file ? req.file.path.replace(/\\/g, '/') : null;
    const userID = req.session.user.UserID;

    db.query('INSERT INTO Post (UserID, Content, Media) VALUES (?, ?, ?)',
        [userID, content, media], (err) => {
            if (err) throw err;
            res.redirect('/home');
        });
});

// 留言功能
app.post('/addComment', (req, res) => {
    const { postID, content } = req.body;
    const userID = req.session.user.UserID;

    db.query('INSERT INTO Comment (PostID, UserID, Content) VALUES (?, ?, ?)',
        [postID, userID, content], (err) => {
            if (err) throw err;
            res.redirect('/home');
        });
});

app.post('/likePost', (req, res) => {
    const { postID } = req.body;
    const userID = req.session.user.UserID;

    if (!userID) {
        return res.status(401).json({ success: false, message: 'Not logged in' });
    }

    db.query('INSERT INTO Likes (PostID, UserID) VALUES (?, ?)', [postID, userID], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ success: false });
        }

        // 👉 更新 Post 表中的 LikeCount 欄位
        db.query(
            'UPDATE Post SET LikeCount = (SELECT COUNT(*) FROM Likes WHERE Likes.PostID = ?) WHERE PostID = ?',
            [postID, postID],
            (err) => {
                if (err) console.error('Failed to update LikeCount:', err);
            }
        );

        // 👉 回傳最新的 Like 數
        db.query('SELECT COUNT(*) AS LikeCount FROM Likes WHERE PostID = ?', [postID], (err, rows) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ success: false });
            }

            res.json({ success: true, likeCount: rows[0].LikeCount });
        });
    });
});


app.get('/admin/dashboard', (req, res) => {
    if (!req.session.adminLoggedIn) return res.redirect('/login');

    db.query(`
        SELECT Post.*, User.Name, User.ProfilePicture, User.UserID, User.Email, User.PhoneNumber
        FROM Post
        JOIN User ON Post.UserID = User.UserID
        ORDER BY Post.Timestamp DESC
    `, (err, posts) => {    
        if (err) throw err;

        db.query(`
            SELECT Comment.*, User.Name
            FROM Comment
            JOIN User ON Comment.UserID = User.UserID
            ORDER BY Comment.Timestamp ASC
        `, (err, comments) => {
            if (err) throw err;

            const moment = require('moment');
            const formattedComments = comments.map(c => ({
                ...c,
                formattedTime: moment(c.Timestamp).fromNow()
            }));

            res.render('adminDashboard', { posts, comments: formattedComments });
        });
    });
});



// Admin 刪除貼文（含留言與按讚）
app.post('/admin/deletePost', (req, res) => {
    if (!req.session.adminLoggedIn) return res.status(403).send('Unauthorized');
    const { postID } = req.body;

    db.query('DELETE FROM Comment WHERE PostID = ?', [postID], (err) => {
        if (err) throw err;
        db.query('DELETE FROM Likes WHERE PostID = ?', [postID], (err) => {
            if (err) throw err;
            db.query('DELETE FROM Post WHERE PostID = ?', [postID], (err) => {
                if (err) throw err;
                res.redirect('/admin/dashboard');
            });
        });
    });
});

// 登出
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) throw err;
        res.redirect('/login');
    });
});

// 啟動伺服器
app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});

app.get('/admin/users', (req, res) => {
    if (!req.session.adminLoggedIn) return res.redirect('/login');

    db.query('SELECT * FROM User ORDER BY UserID ASC', (err, users) => {
        if (err) throw err;
        res.render('adminUsers', { users });
    });
});

// Admin 刪除留言
app.post('/admin/deleteComment', (req, res) => {
    if (!req.session.adminLoggedIn) return res.status(403).send('Unauthorized');
    const { commentID } = req.body;
    db.query('DELETE FROM Comment WHERE CommentID = ?', [commentID], (err) => {
        if (err) throw err;
        res.redirect('/admin/dashboard');
    });
});

app.post('/admin/deleteUser/:id', (req, res) => {
    if (!req.session.adminLoggedIn) return res.status(403).send('Unauthorized');
    
    const userId = req.params.id;

    // 刪除使用者相關資料（留言 → 按讚 → 貼文 → 使用者）
    db.query('DELETE FROM Comment WHERE UserID = ?', [userId], (err) => {
        if (err) throw err;

        db.query('DELETE FROM Likes WHERE UserID = ?', [userId], (err) => {
            if (err) throw err;

            db.query('DELETE FROM Post WHERE UserID = ?', [userId], (err) => {
                if (err) throw err;

                db.query('DELETE FROM User WHERE UserID = ?', [userId], (err) => {
                    if (err) throw err;
                    res.redirect('/admin/users');
                });
            });
        });
    });
});

app.get('/profile/:userId', (req, res) => {
    const userId = req.params.userId;
    const query = 'SELECT * FROM User WHERE UserID = ?';
    
    db.query(query, [userId], (err, results) => {
        if (err) {
            console.error('資料庫查詢錯誤:', err);
            return res.status(500).send('Internal Server Error');
        }

        if (results.length === 0) {
            return res.status(404).send('User not found');
        }

        res.render('profile', { user: results[0] });
    });
});
// 處理個人資料修改
app.post('/profile/:userId/edit', upload.single('profilePicture'), (req, res) => {
    // 檢查是否登入，且只能修改自己的資料
    if (!req.session.loggedIn || req.session.user.UserID != req.params.userId) {
        return res.status(403).send('Unauthorized');
    }

    const userId = req.params.userId;
    const { email, phoneNumber, bio } = req.body;
    let profilePicture = req.session.user.ProfilePicture; // 預設使用舊圖

    // 如果有上傳新圖片，更新路徑
    if (req.file) {
        profilePicture = req.file.path.replace(/\\/g, '/');
    }

    const sql = `
        UPDATE User 
        SET Email = ?, PhoneNumber = ?, Bio = ?, ProfilePicture = ? 
        WHERE UserID = ?
    `;

    db.query(sql, [email, phoneNumber, bio, profilePicture, userId], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Database error');
        }

        // 重要：更新成功後，同步更新 session 裡的 user 資料，否則畫面顯示的還是舊的
        db.query('SELECT * FROM User WHERE UserID = ?', [userId], (err, results) => {
            if (!err && results.length > 0) {
                req.session.user = results[0];
            }
            res.redirect(`/profile/${userId}`); // 回到個人檔案頁面
        });
    });
});

app.get('/user/:userId', (req, res) => {
    const userId = req.params.userId;

    db.query('SELECT * FROM User WHERE UserID = ?', [userId], (err, users) => {
        if (err || users.length === 0) return res.status(404).send('User not found');

        db.query('SELECT * FROM Post WHERE UserID = ? ORDER BY Timestamp DESC', [userId], (err, posts) => {
            if (err) return res.status(500).send('Failed to load posts');

            res.render('userProfile', {
                user: users[0],
                posts: posts
            });
        });
    });
});
