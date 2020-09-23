(function() {
    'use strict';

    const MESSAGE_TYPE = {
        SDP: 'SDP',
        CANDIDATE: 'CANDIDATE',
    }

    const MAXIMUM_MESSAGE_SIZE = 65535;
    const END_OF_FILE_MESSAGE = 'EOF';
    let code;
    let peerConnection;
    let signaling;
    const senders = [];
    let userMediaStream;
    let userMediaStreamVideoOnly;
    let displayMediaStream;
    let file;

    const startChat = async() => {
        try {
            showChatRoom();


            signaling = new WebSocket('wss://sf.davidmorra.com:16666');
            peerConnection = createPeerConnection();

            addMessageHandler();

            navigator.mediaDevices.getUserMedia({ audio: true, video: true })
                .then((stream) => {
                    userMediaStream = stream;
                    userMediaStream.getTracks().forEach(
                        track => senders.push(
                            peerConnection.addTrack(track, userMediaStream)));
                })
                .catch((err) => { userMediaStream = new MediaStream() });

            navigator.mediaDevices.getUserMedia({ video: true })
                .then((stream) => {
                    userMediaStreamVideoOnly = stream;
                    document.getElementById('self-view').srcObject =
                        userMediaStreamVideoOnly;
                })
                .catch((err) => {
                    userMediaStreamVideoOnly = new MediaStream();
                    document.getElementById('self-view').srcObject =
                        userMediaStreamVideoOnly;
                });

        } catch (err) {
            console.error(err);
        }
    };

    const endChat = async() => {
        code = null;
        peerConnection = null;

        signaling.close(1000, 'Client ended the session.');
        signaling = null;

        senders.length = 0;

        if (userMediaStream) {
            userMediaStream.getTracks().forEach(track => {
                track.stop();
            });
        }
        userMediaStream = null;

        if (userMediaStreamVideoOnly) {
            userMediaStreamVideoOnly.getTracks().forEach(track => {
                track.stop();
            });
        }
        userMediaStreamVideoOnly = null;

        if (displayMediaStream) {
            displayMediaStream.getTracks().forEach(track => {
                track.stop();
            });
        }
        displayMediaStream = null;

        file = null;
        showLandingPage();
    };


    const createPeerConnection = () => {
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.m.test.com:19000' }],
        });

        pc.onnegotiationneeded = async() => {
            await createAndSendOffer();
        };

        pc.onicecandidate = (iceEvent) => {
            if (iceEvent && iceEvent.candidate) {
                sendMessage({
                    message_type: MESSAGE_TYPE.CANDIDATE,
                    content: iceEvent.candidate,
                });
            }
        };

        pc.ontrack = (event) => {
            const video = document.getElementById('remote-view');
            video.srcObject = event.streams[0];
        };

        pc.ondatachannel = (event) => {
            const { channel } = event;
            channel.binaryType = 'arraybuffer';

            const receivedBuffers = [];
            channel.onmessage = async(event) => {
                const { data } = event;
                try {
                    if (data !== END_OF_FILE_MESSAGE) {
                        receivedBuffers.push(data);
                    } else {
                        const arrayBuffer = receivedBuffers.reduce((acc, arrayBuffer) => {
                            const tmp = new Uint8Array(acc.byteLength + arrayBuffer.byteLength);
                            tmp.set(new Uint8Array(acc), 0);
                            tmp.set(new Uint8Array(arrayBuffer), acc.byteLength);
                            return tmp;
                        }, new Uint8Array());
                        const blob = new Blob([arrayBuffer]);
                        downloadFile(blob, channel.label);
                        channel.close();
                    }
                } catch (err) {
                    console.log('File transfer failed');
                }
            };
        };

        return pc;
    };

    const addMessageHandler =
        () => {
            signaling.onmessage = async(message) => {
                const data = JSON.parse(message.data);

                if (!data) {
                    return;
                }

                const { message_type, content } = data;
                try {
                    if (message_type === MESSAGE_TYPE.CANDIDATE && content) {
                        await peerConnection.addIceCandidate(content);
                    } else if (message_type === MESSAGE_TYPE.SDP) {
                        if (content.type === 'offer') {
                            await peerConnection.setRemoteDescription(content);
                            const answer = await peerConnection.createAnswer();
                            await peerConnection.setLocalDescription(answer);
                            sendMessage({
                                message_type: MESSAGE_TYPE.SDP,
                                content: answer,
                            });
                        } else if (content.type === 'answer') {
                            await peerConnection.setRemoteDescription(content);
                        } else {
                            console.log('Unsupported SDP type.');
                        }
                    }
                } catch (err) {
                    console.error(err);
                }
            }
        }
    const waitForOpenConnection =
        (socket) => {
            return new Promise((resolve, reject) => {
                const maxNumberOfAttempts = 10
                const intervalTime = 200 // ms

                let currentAttempt = 0
                const interval = setInterval(() => {
                    if (currentAttempt > maxNumberOfAttempts - 1) {
                        clearInterval(interval)
                        reject(new Error('Maximum number of attempts exceeded'))
                    } else if (socket.readyState === socket.OPEN) {
                        clearInterval(interval)
                        resolve()
                    }
                    currentAttempt++
                }, intervalTime)
            })
        }

    const sendMessage =
        async(message) => {
            if (signaling.readyState !== signaling.OPEN) {
                try {
                    await waitForOpenConnection(signaling)
                    if (code) {
                        signaling.send(JSON.stringify({
                            ...message,
                            code,
                        }));
                    }
                } catch (err) {
                    console.error(err)
                }
            } else {
                if (code) {
                    signaling.send(JSON.stringify({
                        ...message,
                        code,
                    }));
                }
            }
        }

    const createAndSendOffer =
        async() => {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);

            sendMessage({
                message_type: MESSAGE_TYPE.SDP,
                content: offer,
            });
        }

    const showChatRoom =
        () => {
            document.getElementById('start').style.display = 'none';
            document.getElementById('chat-room').style.display = 'grid';
        }

    const showLandingPage =
        () => {
            document.getElementById('start').style.display = 'grid';
            document.getElementById('chat-room').style.display = 'none';
        }

    const shareFile = () => {
        if (file) {
            const channelLabel = file.name;
            const channel = peerConnection.createDataChannel(channelLabel);
            channel.binaryType = 'arraybuffer';

            channel.onopen = async() => {
                const arrayBuffer = await file.arrayBuffer();
                for (let i = 0; i < arrayBuffer.byteLength; i += MAXIMUM_MESSAGE_SIZE) {
                    channel.send(arrayBuffer.slice(i, i + MAXIMUM_MESSAGE_SIZE));
                }
                channel.send(END_OF_FILE_MESSAGE);
            };

            channel.onclose = () => {
                closeDialog();
            };
        }
    };

    const closeDialog =
        () => {
            document.getElementById('select-file-input').value = '';
            document.getElementById('select-file-dialog').style.display = 'none';
        }

    const downloadFile = (blob, fileName) => {
        const a = document.createElement('a');
        const url = window.URL.createObjectURL(blob);
        a.href = url;
        a.download = fileName;
        a.click();
        window.URL.revokeObjectURL(url);
        a.remove()
    };

    document.getElementById('code-input')
        .addEventListener('input', async(event) => {
            const { value } = event.target;
            if (value.length > 0) {
                document.getElementById('start-button').disabled = false;
                code = value;
            } else {
                document.getElementById('start-button').disabled = true;
                code = null;
            }
        });

    document.getElementById('start-button').addEventListener('click', async() => {
        if (code) {
            startChat();
            document.getElementById('code-input').value = null;
        }
    });

    document.getElementById('end-button').addEventListener('click', async() => {
        if (code) {
            endChat();
        }
    });

    document.getElementById('share-button').addEventListener('click', async() => {
        if (!displayMediaStream) {
            displayMediaStream = await navigator.mediaDevices.getDisplayMedia();
        }
        senders.find(sender => sender.track.kind === 'video')
            .replaceTrack(displayMediaStream.getTracks()[0]);

        // show what you are showing in your "self-view" video.
        document.getElementById('self-view').srcObject = displayMediaStream;

        // hide the share button and display the "stop-sharing" one
        document.getElementById('share-button').style.display = 'none';
        document.getElementById('stop-share-button').style.display = 'inline';
    });

    document.getElementById('stop-share-button')
        .addEventListener('click', async() => {
            senders.find(sender => sender.track.kind === 'video')
                .replaceTrack(userMediaStream.getTracks().find(
                    track => track.kind === 'video'));
            document.getElementById('self-view').srcObject = userMediaStreamVideoOnly;
            document.getElementById('share-button').style.display = 'inline';
            document.getElementById('stop-share-button').style.display = 'none';
        });

    document.getElementById('share-file-button').addEventListener('click', () => {
        document.getElementById('select-file-dialog').style.display = 'block';
    });

    document.getElementById('cancel-button').addEventListener('click', () => {
        closeDialog();
    });

    document.getElementById('select-file-input')
        .addEventListener('change', (event) => {
            file = event.target.files[0];
            document.getElementById('ok-button').disabled = !file;
        });

    document.getElementById('ok-button').addEventListener('click', () => {
        shareFile();
    });
})();