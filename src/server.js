const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

const server = require('http').createServer(app);

const io = require('socket.io')(server);

app.use(express.static(path.join(__dirname, '../public')));
app.set('views', path.join( __dirname, '../public'));
app.engine('html', require('ejs').renderFile);
app.set('view engine', 'html');
app.use(cors());

app.use('/', (req, res) => {
    res.render('index.html');
})

let connectedUsers = [];

io.on('connection', socket => {

    const connectedUser = {
        id: socket.id,
        number: connectedUsers.length + 1,
    }
    connectedUsers.push(connectedUser);
    console.log('User connection\n', connectedUsers);
    socket.broadcast.emit('updateConnections', connectedUsers);

    socket.on('disconnect', () => {
        i = 0;
        connectedUsers = connectedUsers.filter(connectedUser => {
            return connectedUser.id !== socket.id;
        }).map(connectedUser => {
            i++;
            return {
                id: connectedUser.id,
                number: connectedUser.number = i,
            }
        })
        console.log('User disconnection\n', connectedUsers);
        socket.broadcast.emit('updateConnections', connectedUsers);
    })

})

server.listen(3000);
