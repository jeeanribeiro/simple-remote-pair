var io = require('socket.io-client');
var Peer = require('simple-peer');
var wrtc = require('wrtc');

var socket = io(window.location.href);

var sessionId;
socket.on('connect', function() {
    sessionId = socket.id;
});

if (location.hash === '#host') {

    socket.emit('newHost');

    var hostStream;
    window.onload = function() {
        var button = document.createElement('button');
        document.querySelector('div').appendChild(button);

        button.addEventListener('click', function() {
            navigator.mediaDevices.getDisplayMedia({ video: true })
                .then(function(stream) {
                    hostStream = stream;
                })
                .catch(function(error) {
                    console.log('error', error);
                })
        })
    }

    var connectionList = [];

    socket.on('newConnection', function(socketId) {
        var connection = {
            socketId: socketId,
            peer: new Peer({ initiator: true, trickle: false, wrtc: wrtc, stream: hostStream }),
            offer: '',
            answer: ''
        }

        connection.peer.on('signal', function(offer) {
            connection.offer = JSON.stringify(offer);
            socket.emit('newOffer', connection);
        })

        socket.on('newAnswer', function(answer) {
            if (answer.socketId === connection.socketId) {
                connection.answer = answer;
                connection.peer.signal(connection.answer.answer);
            }
        })

        connectionList.push(connection);
    })

    connectionList.forEach(function (connection) {
        connection.peer.on('data', function (data) {
            console.log('data: ' + data);
        })

        connection.peer.on('error', function(error) {
            console.log('error', error);
        })
    })

} else {

    var peer = new Peer({ trickle: false, wrtc: wrtc });

    socket.on('newOffer', function(connection) {
        console.log(connection);
        peer.signal(connection.offer);
    })

    peer.on('signal', function(answer) {
        answer = {
            answer: JSON.stringify(answer),
            socketId: sessionId
        }
        socket.emit('newAnswer', answer);
    })

    peer.on('stream', function(stream) {
        var video = document.querySelector('video');

        if ('srcObject' in video) {
            video.srcObject = stream;
        } else {
            video.src = window.URL.createObjectURL(stream);
        }
    })

    peer.on('connect', function() {
        peer.send('peer connected');
    })

    peer.on('error', function(error) {
        console.log('error', error);
    })

    window.onload = function() {
        var video = document.querySelector('video');

        video.addEventListener('click', function (event) {
            socket.emit('leftClick', {
                x: event.clientX - video.getBoundingClientRect().left,
                y: event.clientY - video.getBoundingClientRect().top,
                videoWidth: video.getBoundingClientRect().width,
                videoHeight: video.getBoundingClientRect().height,
            })
        })

        video.addEventListener('contextmenu', function (event) {
            socket.emit('rightClick', {
                x: event.clientX - video.getBoundingClientRect().left,
                y: event.clientY - video.getBoundingClientRect().top,
                videoWidth: video.getBoundingClientRect().width,
                videoHeight: video.getBoundingClientRect().height,
            })
        })

        video.addEventListener('dblclick', function (event) {
            socket.emit('doubleClick', {
                x: event.clientX - video.getBoundingClientRect().left,
                y: event.clientY - video.getBoundingClientRect().top,
                videoWidth: video.getBoundingClientRect().width,
                videoHeight: video.getBoundingClientRect().height,
            })
        })

        video.addEventListener('mousedown', function () {
            video.addEventListener('mousemove', function (event) {
                socket.emit('dragMouse', {
                    x: event.clientX - video.getBoundingClientRect().left,
                    y: event.clientY - video.getBoundingClientRect().top,
                    videoWidth: video.getBoundingClientRect().width,
                    videoHeight: video.getBoundingClientRect().height,
                })
            })
        })

        video.addEventListener('wheel', function(event) {
            socket.emit('scroll', {
                x: event.deltaX,
                y: event.deltaY,
            })
        })

        window.addEventListener('keypress', function (event) {
            socket.emit('keyPress', event.key)
        })
    }

}
