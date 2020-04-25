var socket = io(window.location.href);

socket.on('connection', console.log('socket connected'));
