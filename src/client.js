var io = require('socket.io-client');

var socket = io(window.location.href);

socket.on('connection', console.log('socket connected'));
