var io = require('socket.io-client');
var Peer = require('simple-peer');
var wrtc = require('wrtc');

var socket = io(window.location.href);

var video = document.querySelector('video');

socket.on('connection', console.log('socket connected'));

if (location.hash === '#host') {

    socket.emit('newHost');

    var peerList = [];

    socket.on('newConnection', function() {
        peerList.push(new Peer({ initiator: true, trickle: false, wrtc: wrtc }));
        lastPeer = peerList[peerList.length - 1];

        lastPeer.on('signal', function(offer) {
            socket.emit('newOffer', offer);
        })

        socket.on('newAnswer', function(answer) {
            lastPeer.signal(JSON.stringify(answer));
        })

        lastPeer.on('data', function (data) {
            console.log('data: ' + data);
        })

        lastPeer.on('error', function(error) {
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

}
