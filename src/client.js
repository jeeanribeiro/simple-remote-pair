var io = require('socket.io-client');
var Peer = require('simple-peer');
var wrtc = require('wrtc');

var socket = io(window.location.href);

socket.on('connection', console.log('socket connected'));

if (location.hash === '#host') {

    socket.emit('newHost');

    var peerList = [];

    socket.on('newConnection', function() {
        peerList.push(new Peer({ initiator: true, trickle: false, wrtc: wrtc }));
        peer = peerList[peerList.length - 1];

        peer.on('signal', function(offer) {
            socket.emit('newOffer', offer);
        })

        socket.on('newAnswer', function(answer) {
            peer.signal(JSON.stringify(answer));
        })

        peer.on('data', function (data) {
            console.log('data: ' + data);
        })

        peer.on('error', function(error) {
            console.log('error', error);
        })

        navigator.mediaDevices.getDisplayMedia({ video: true })
            .then(function(stream) {
                peer.addStream(stream);
            })
            .catch(function(error) {
                console.log('error', error);
        })
    })

} else {

    var peer = new Peer({ trickle: false, wrtc: wrtc });

    socket.on('newOffer', function(offer) {
        peer.signal(JSON.stringify(offer));
    })

    peer.on('signal', function(answer) {
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

        video.addEventListener('mousedown', function (event) {
            console.log('click');
            socket.emit('mouseClick', {
                x: event.clientX - video.getBoundingClientRect().left,
                y: event.clientY - video.getBoundingClientRect().top,
                videoWidth: video.getBoundingClientRect().width,
                videoHeight: video.getBoundingClientRect().height
            })
        })

        window.addEventListener('keypress', function (event) {
            socket.emit('keyPress', event.key)
        })
    }

}
