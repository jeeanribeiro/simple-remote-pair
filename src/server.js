const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();

const server = require('http').createServer(app);

const io = require('socket.io')(server);

const robot = require('robotjs');

const dict = require('./dict');

app.use(express.static(path.join(__dirname, '../public')));
app.set('views', path.join(__dirname, '../public'));
app.engine('html', require('ejs').renderFile);
app.set('view engine', 'html');
app.use(cors());

app.use('/', (req, res) => {
    res.render('index.html');
})

let connectedUsers = [];
let hostId;

io.on('connection', socket => {

    const connectedUser = {
        id: socket.id,
        number: connectedUsers.length + 1,
    }
    connectedUsers.push(connectedUser);
    console.log('User connection\n', connectedUsers);

    socket.on('newHost', () => {
        console.log('new host');
        hostId = socket.id;
    })

    io.to(hostId).emit('newConnection', socket.id);

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
    })

    socket.on('newOffer', data => {
        io.to(data.socketId).emit('newOffer', data);
    })

    socket.on('newAnswer', answer => {
        io.to(hostId).emit('newAnswer', answer);
    })

    function convertCoord(coords, xy) {
        if (xy === 'x') {
            return (robot.getScreenSize().width * coords.x) / coords.videoWidth;
        } else if (xy === 'y') {
            return (robot.getScreenSize().height * coords.y) / coords.videoHeight;
        } else {
            return;
        }
    }

    socket.on('leftClick', coords => {
        robot.moveMouse(convertCoord(coords, 'x'), convertCoord(coords, 'y'));
    })

    socket.on('rightClick', coords => {
        robot.moveMouse(convertCoord(coords, 'x'), convertCoord(coords, 'y'));
        robot.mouseClick('right');
    })

    socket.on('mouseDown', coords => {
        robot.moveMouse(convertCoord(coords, 'x'), convertCoord(coords, 'y'));
        robot.mouseToggle('down');
    })

    socket.on('dragMouse', coords => {
        robot.dragMouse(convertCoord(coords, 'x'), convertCoord(coords, 'y'));
    })

    socket.on('mouseUp', () => {
        robot.mouseToggle('up');
    })

    socket.on('scroll', delta => {
        robot.scrollMouse(delta.x, delta.y);
    })

    socket.on('keyDown', key => {
        if (key.length !== 1 && key !== ' ') {
            key = dict[key];
        }

        try {
            robot.keyTap(key);
        } catch (err) {
            console.log('error', err);
        }
    })

})

server.listen(3000);
