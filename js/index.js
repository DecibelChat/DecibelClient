(function() {
'use strict';

const MESSAGE_TYPE = {
  SDP : 'SDP',
  CANDIDATE : 'CANDIDATE',
  SERVER : 'SERVER',
  DELETE : 'DELETE'
}

class Peer
{
  constructor(parent = document.getElementById('remote-view-container'))
  {
    this.video          = document.createElement('video');
    this.video.id       = `remote-view-${Object.keys(peerConnection).length}`;
    this.video.autoplay = true;

    parent.appendChild(this.video);

    this.connection = createPeerConnection(this.video);

    this.connection.ontrack = (event) => {
      if (this.video.srcObject !== event.streams[0])
      {
        this.video.srcObject = event.streams[0];
        console.log(`${this.video.id}: new remote stream`);
      }
    };
  }
};

const MAXIMUM_MESSAGE_SIZE = 65535;
const END_OF_FILE_MESSAGE  = 'EOF';
let code;
let peerConnection = {};
let signaling;
const senders   = [];
let userDevices = {};
let userAudioStream;
let userVideoStream;
let displayMediaStream;
let file;
let host_id;

let server_url  = 'sf.davidmorra.com';
let server_port = 16666;

const startChat = async () => {
  try
  {
    showChatRoom();

    signaling = new WebSocket(`wss://${server_url}:${server_port}`);

    addMessageHandler();

    getMedia().then(() => {sendMessage({message_type : MESSAGE_TYPE.SERVER, content : 'join meeting'})});
  }
  catch (err)
  {
    console.error(err);
  }
};

const getMedia = async () => {
  try
  {
    // make sure camera/microphone permissions are resolved before anything
    // else.
    try
    {
      await navigator.mediaDevices.getUserMedia({audio : true, video : true});
    }
    catch (error)
    {
      console.log(error);
    }

    let promises = [];

    promises.push(navigator.mediaDevices.getUserMedia({audio : true})
                      .then((stream) => {
                        userAudioStream = stream;
                      })
                      .catch((err) => {userAudioStream = new MediaStream()}));

    promises.push(navigator.mediaDevices.getUserMedia({video : true})
                      .then((stream) => {
                        userVideoStream = stream;
                      })
                      .catch((err) => {
                        userVideoStream = new MediaStream();
                      })
                      .finally(() => {
                        document.getElementById('self-view').srcObject = userVideoStream;
                      }));

    promises.push(navigator.mediaDevices.enumerateDevices()
                      .then(devices => {devices.forEach(device => {
                              let kind = device.kind;
                              if (!(kind in userDevices))
                              {
                                userDevices[kind] = [];
                              }

                              userDevices[kind].push(device);
                              console.log(userDevices);

                              let selector;
                              let default_option_string;
                              if (kind == 'audioinput')
                              {
                                selector              = document.getElementById('audio-source-menu');
                                default_option_string = 'Default Audio Input';
                              }
                              else if (kind == 'videoinput')
                              {
                                selector              = document.getElementById('video-source-menu');
                                default_option_string = 'Default Video Input';
                              }
                              if (selector)
                              {
                                let option  = document.createElement('option');
                                option.text = device.label.length ? device.label : default_option_string;
                                selector.options.add(option);
                              }
                            })})
                      .finally(() => {
                        let audio_selector = document.getElementById('audio-source-menu');
                        if (audio_selector.options.length === 0)
                        {
                          let option  = document.createElement('option');
                          option.text = 'No audio inputs found.';
                          audio_selector.options.add(option);
                        }
                        let video_selector = document.getElementById('video-source-menu');
                        if (video_selector.options.length === 0)
                        {
                          let option  = document.createElement('option');
                          option.text = 'No video inputs found.';
                          video_selector.options.add(option);
                        }
                      }));

    await Promise.all(promises);
  }
  catch (err)
  {
    console.error(err);
  }
};

const endChat = async () => {
  code = null;

  for (let key in peerConnection)
  {
    peerConnection[key].connection.close();
  }
  // peerConnection.close();
  peerConnection = {};

  signaling.close(1000, 'Client ended the session.');
  signaling = null;

  senders.length = 0;

  if (userAudioStream)
  {
    userAudioStream.getTracks().forEach(track => {
      track.stop();
    });
  }
  userAudioStream = null;

  if (userVideoStream)
  {
    userVideoStream.getTracks().forEach(track => {
      track.stop();
    });
  }
  userVideoStream = null;

  if (displayMediaStream)
  {
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
    iceServers : [ {urls : 'stun:stun.m.test.com:19000'} ],
  });

  pc.onnegotiationneeded = async () => {
    await createAndSendOffer(pc);
  };

  pc.onicecandidate = (iceEvent) => {
    if (iceEvent && iceEvent.candidate)
    {
      sendMessage({
        message_type : MESSAGE_TYPE.CANDIDATE,
        content : iceEvent.candidate,
      });
    }
  };

  pc.ondatachannel = (event) => {
    const {channel}    = event;
    channel.binaryType = 'arraybuffer';

    const receivedBuffers = [];
    channel.onmessage = async (event) => {
      const {data} = event;
      try
      {
        if (data !== END_OF_FILE_MESSAGE)
        {
          receivedBuffers.push(data);
        }
        else
        {
          const arrayBuffer = receivedBuffers.reduce((acc, arrayBuffer) => {
            const tmp = new Uint8Array(acc.byteLength + arrayBuffer.byteLength);
            tmp.set(new Uint8Array(acc), 0);
            tmp.set(new Uint8Array(arrayBuffer), acc.byteLength);
            return tmp;
          }, new Uint8Array());
          const blob        = new Blob([ arrayBuffer ]);
          downloadFile(blob, channel.label);
          channel.close();
        }
      }
      catch (err)
      {
        console.log('File transfer failed');
      }
    };
  };

  userAudioStream.getTracks().forEach(track => senders.push(pc.addTrack(track, userAudioStream)));

  userVideoStream.getTracks().forEach(track => senders.push(pc.addTrack(track, userVideoStream)));

  return pc;
};

const updateRemoteViewLayout = async () => {
  let container = document.getElementById('remote-view-container');

  let desired_rows    = 1;
  let desired_columns = 1;

  let num_peers = Object.keys(peerConnection).length;
  if (num_peers > 1)
  {
    desired_columns = 2;
    desired_rows    = Math.ceil(num_peers / desired_columns);
  }

  let desired_column_str = `repeat(${desired_columns}, 1fr)`;
  let desired_row_str    = `repeat(${desired_rows}, 1fr)`;

  let current_columns = container.style.gridTemplateColumns;
  let current_rows    = container.style.gridTemplateRows;

  if (desired_column_str !== current_columns || desired_row_str !== current_rows)
  {
    container.style.gridTemplateColumns = desired_column_str;
    container.style.gridTemplateRows    = desired_row_str;

    let ii = 0
    for (let key in peerConnection)
    {
      let row    = Math.floor(ii / desired_columns) + 1;
      let column = ii % desired_columns + 1;

      peerConnection[key].video.style.gridRowStart    = row;
      peerConnection[key].video.style.gridColumnStart = column;

      ii++;
    }
  }
};

const addMessageHandler = () => {
  signaling.onmessage = async (message) => {
    const data = JSON.parse(message.data);

    if (!data)
    {
      return;
    }

    const {message_type, content, peer_id} = data;
    try
    {
      if (!(peer_id in peerConnection))
      {
        peerConnection[peer_id] = new Peer();
        updateRemoteViewLayout();
      }

      let pc = peerConnection[peer_id].connection;

      if (message_type === MESSAGE_TYPE.CANDIDATE && content)
      {
        console.log(`trying to add candidate ${peer_id} with content: ${content}`);
        pc.addIceCandidate(content).then(
            () => {
              console.log('AddIceCandidate success.');
            },
            (error) => {
              console.log(`Failed to add ICE candidate: ${error.toString()}`);
            });
      }
      else if (message_type === MESSAGE_TYPE.SDP)
      {
        if (content.type === 'offer')
        {
          await pc.setRemoteDescription(content);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendMessage({
            message_type : MESSAGE_TYPE.SDP,
            content : answer,
          });
        }
        else if (content.type === 'answer')
        {
          pc.setRemoteDescription(content);
        }
        else
        {
          console.log('Unsupported SDP type.');
        }
      }
      else if (message_type === MESSAGE_TYPE.DELETE)
      {
        peerConnection[peer_id].video.remove();
        peerConnection[peer_id].connection.close();
        delete peerConnection[peer_id];

        updateRemoteViewLayout();
      }
      else if (message_type === MESSAGE_TYPE.SERVER)
      {
        if (content === 'your id')
        {
          ƒhost_id = peer_id;
        }
      }
    }
    catch (err)
    {
      console.log(err);
    }
  }
};
const waitForOpenConnection =
    (socket) => {
            return new Promise((resolve, reject) => {
                const maxNumberOfAttempts = 10
            const intervalTime = 200 // ms

            let currentAttempt = 0
                const interval = setInterval(() => {
    if (currentAttempt > maxNumberOfAttempts - 1)
    {
      clearInterval(interval)
      reject(new Error('Maximum number of attempts exceeded'))
    }
    else if (socket.readyState === socket.OPEN)
    {
      clearInterval(interval)
      resolve()
    }
    currentAttempt++
                }, intervalTime)
            })
    }

const sendMessage =
    async (message) => {
  if (signaling.readyState !== signaling.OPEN)
  {
    try
    {
      await waitForOpenConnection(signaling)
      if (code)
      {
        signaling.send(JSON.stringify({
          ...message,
          code,
        }));
      }
    }
    catch (err)
    {
      console.error(err)
    }
  }
  else
  {
    if (code)
    {
      signaling.send(JSON.stringify({
        ...message,
        code,
      }));
    }
  }
}

const createAndSendOffer =
    async (pc) => {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  sendMessage({
    message_type : MESSAGE_TYPE.SDP,
    content : offer,
  });
}

const showChatRoom =
    () => {
      document.getElementById('start').style.display     = 'none';
      document.getElementById('chat-room').style.display = 'grid';
    }

const showLandingPage =
    () => {
      document.getElementById('start').style.display     = 'grid';
      document.getElementById('chat-room').style.display = 'none';
    }

const shareFile = () => {
  if (file)
  {
    const channelLabel = file.name;
    for (let key in peerConnection)
    {
      const channel      = peerConnection[key].createDataChannel(channelLabel);
      channel.binaryType = 'arraybuffer';

      channel.onopen = async () => {
        const arrayBuffer = await file.arrayBuffer();
        for (let i = 0; i < arrayBuffer.byteLength; i += MAXIMUM_MESSAGE_SIZE)
        {
          channel.send(arrayBuffer.slice(i, i + MAXIMUM_MESSAGE_SIZE));
        }
        channel.send(END_OF_FILE_MESSAGE);
      };

      channel.onclose = () => {
        closeDialog();
      };
    }
  }
};

const closeDialog =
    () => {
      document.getElementById('select-file-input').value          = '';
      document.getElementById('select-file-dialog').style.display = 'none';
    }

const downloadFile = (blob, fileName) => {
  const a    = document.createElement('a');
  const url  = window.URL.createObjectURL(blob);
  a.href     = url;
  a.download = fileName;
  a.click();
  window.URL.revokeObjectURL(url);
  a.remove()
};

document.getElementById('code-input').addEventListener('input', async (event) => {
  const {value} = event.target;
  if (value.length > 0)
  {
    document.getElementById('start-button').disabled = false;
    code                                             = value;
  }
  else
  {
    document.getElementById('start-button').disabled = true;
    code                                             = null;
  }
});

document.getElementById('start-button').addEventListener('click', async () => {
  if (code)
  {
    startChat();
    document.getElementById('code-input').value = null;
  }
});

document.getElementById('end-button').addEventListener('click', async () => {
  if (code)
  {
    endChat();
  }
});

document.getElementById('mic-mute-button').addEventListener('click', async () => {
  let button        = document.getElementById('mic-mute-button');
  let icon          = button.children[0];
  let current_value = icon.classList.value;

  if (current_value.includes('slash'))
  {
    userAudioStream.getTracks().forEach(track => {
      track.enabled = true;
    });

    icon.classList.toggle('fa-microphone');
    button.style.backgroundColor = ''
  }
  else
  {
    userAudioStream.getTracks().forEach(track => {
      track.enabled = false;
    });
    icon.classList.toggle('fa-microphone-slash');
    button.style.backgroundColor = '#97a2ab'
  }
});

document.getElementById('camera-mute-button').addEventListener('click', async () => {
  let button        = document.getElementById('camera-mute-button');
  let icon          = button.children[0];
  let current_value = icon.classList.value;

  if (current_value.includes('slash'))
  {
    userVideoStream.getTracks().forEach(track => {
      track.enabled = true;
    });
    icon.classList.toggle('fa-video');
    button.style.backgroundColor = ''
  }
  else
  {
    userVideoStream.getTracks().forEach(track => {
      track.enabled = false;
    });
    icon.classList.toggle('fa-video-slash');
    button.style.backgroundColor = '#97a2ab'
  }
});

document.getElementById('share-button').addEventListener('click', async () => {
  if (!displayMediaStream)
  {
    displayMediaStream = await navigator.mediaDevices.getDisplayMedia();
  }
  senders.find(sender => sender.track.kind === 'video').replaceTrack(displayMediaStream.getTracks()[0]);

  // show what you are showing in your "self-view" video.
  document.getElementById('self-view').srcObject = displayMediaStream;

  // hide the share button and display the "stop-sharing" one
  document.getElementById('share-button').style.display      = 'none';
  document.getElementById('stop-share-button').style.display = 'inline';
});

document.getElementById('stop-share-button').addEventListener('click', async () => {
  senders.find(sender => sender.track.kind === 'video')
      .replaceTrack(userVideoStream.getTracks().find(track => track.kind === 'video'));
  document.getElementById('self-view').srcObject             = userVideoStream;
  document.getElementById('share-button').style.display      = 'inline';
  document.getElementById('stop-share-button').style.display = 'none';
});

document.getElementById('share-file-button').addEventListener('click', () => {
  document.getElementById('select-file-dialog').style.display = 'block';
});

document.getElementById('cancel-button').addEventListener('click', () => {
  closeDialog();
});

document.getElementById('select-file-input').addEventListener('change', (event) => {
  file                                          = event.target.files[0];
  document.getElementById('ok-button').disabled = !file;
});

document.getElementById('ok-button').addEventListener('click', () => {
  shareFile();
});
})();