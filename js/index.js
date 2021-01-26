(function() {
'use strict';

const MESSAGE_TYPE = {
  SDP : 'SDP',
  CANDIDATE : 'CANDIDATE',
  SERVER : 'SERVER',
  DELETE : 'DELETE',
  VOLUME : 'VOLUME',
  POSITION : 'POSITION'
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

  set_volume(level)
  {
    this.video.volume = level;
  }
  close()
  {
    document.getElementById(this.video.id).remove();
    this.video.remove();
    this.connection.close();
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
let self_view_resize_observer = new ResizeObserver(handleResize).observe(document.getElementById('self-view-parent'));

let params = {
  "local" : {"protocol" : "ws"},
  "remote" : {"server_url" : "internal.decibelchat.com", "port" : 16666, "protocol" : "wss"}
};

function inTestingMode()
{
  if (window.location.protocol == 'file:' ||
      !window.location.hostname.replace(/localhost|\d{0,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/i, ''))
  {
    return true;
  }
  return false;
}

function setCookie(name, value, days)
{
  var expires = "";
  if (days)
  {
    var date = new Date();
    date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
    expires = "; expires=" + date.toUTCString();
  }
  document.cookie = name + "=" + (value || "") + expires + "; path=/";
}
function getCookie(name)
{
  var nameEQ = name + "=";
  var ca     = document.cookie.split(';');
  for (var i = 0; i < ca.length; i++)
  {
    var c = ca[i];
    while (c.charAt(0) == ' ') c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
}
function eraseCookie(name)
{
  document.cookie = name + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
}

async function startChat()
{
  try
  {
    showChatRoom();
    document.getElementById('self-view-parent').is_docked = true;

    let mode = inTestingMode() ? "local" : "remote";

    if (mode == "local")
    {
      if (!getCookie("server_url"))
      {
        setCookie("server_url", "localhost");
      }

      if (!getCookie("server_port"))
      {
        setCookie("server_port", "16666");
      }

      var input        = prompt("Developer Mode: Enter a server URL.", `${getCookie("server_url")}:${getCookie("server_port")}`);
      var input_pieces = input.split(':');
      params[mode].server_url = input_pieces[0];
      params[mode].port       = input_pieces[1];

      setCookie("server_url", params[mode].server_url);
      setCookie("server_port", params[mode].port);
    }

    signaling = new WebSocket(`${params[mode].protocol}://${params[mode].server_url}:${params[mode].port}`);

    addMessageHandler();

    getMedia().then(() => {
      sendMessage({message_type : MESSAGE_TYPE.SERVER, content : 'join meeting'});
      // sendMessage({message_type : MESSAGE_TYPE.POSITION, content : {position : {x : 1, y : 0, z : 0}}});
    });
  }
  catch (err)
  {
    console.error(err);
  }
};

async function getMedia()
{
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
                      .then((stream) => { userAudioStream = stream; })
                      .catch((err) => {userAudioStream = new MediaStream()}));

    promises.push(navigator.mediaDevices.getUserMedia({video : true})
                      .then((stream) => { userVideoStream = stream; })
                      .catch((err) => { userVideoStream = new MediaStream(); })
                      .finally(() => { document.getElementById('self-view').srcObject = userVideoStream; }));

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

async function endChat()
{
  code                                           = null;
  document.getElementById('self-view').srcObject = null;

  for (let key in peerConnection)
  {
    peerConnection[key].close();
  }
  // peerConnection.close();
  peerConnection = {};

  for (let key in userDevices)
  {
    delete userDevices[key];
  }

  senders.length = 0;

  if (userAudioStream)
  {
    userAudioStream.getTracks().forEach(track => { track.stop(); });
  }
  userAudioStream = null;

  if (userVideoStream)
  {
    userVideoStream.getTracks().forEach(track => { track.stop(); });
  }
  userVideoStream = null;

  if (displayMediaStream)
  {
    displayMediaStream.getTracks().forEach(track => { track.stop(); });
  }
  displayMediaStream = null;

  file = null;
  showLandingPage();

  signaling.close(1000, 'Client ended the session.');
  signaling = null;
};

function createPeerConnection()
{
  const pc = new RTCPeerConnection({
    iceServers : [ {urls : 'stun:stun.m.test.com:19000'} ],
  });

  pc.onnegotiationneeded = async () => { await createAndSendOffer(pc); };

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

  if (userAudioStream)
  {
    userAudioStream.getTracks().forEach(track => senders.push(pc.addTrack(track, userAudioStream)));
  }
  if (userVideoStream)
  {
    userVideoStream.getTracks().forEach(track => senders.push(pc.addTrack(track, userVideoStream)));
  }
  if (displayMediaStream)
  {
    displayMediaStream.getTracks().forEach(track => senders.push(pc.addTrack(track, displayMediaStream)));
  }
  return pc;
};

async function updateRemoteViewLayout()
{
  let container = document.getElementById('remote-view-container');

  let desired_rows    = 1;
  let desired_columns = 1;

  let num_peers = Object.keys(peerConnection).length;
  if (host_id in peerConnection)
  {
    num_peers--;
  }

  if (num_peers > 1)
  {
    desired_columns = 2;
    desired_rows    = Math.ceil(num_peers / desired_columns);
  }

  let desired_column_str = `repeat(${desired_columns}, 1fr)`;
  let desired_row_str    = `repeat(${desired_rows}, 1fr)`;

  let current_columns = container.style.gridTemplateColumns;
  let current_rows    = container.style.gridTemplateRows;

  container.style.gridTemplateColumns = desired_column_str;
  container.style.gridTemplateRows    = desired_row_str;

  let ii = 0
  for (let key in peerConnection)
  {
    if (key !== host_id)
    {
      let row    = Math.floor(ii / desired_columns) + 1;
      let column = ii % desired_columns + 1;

      peerConnection[key].video.style.gridRowStart    = row;
      peerConnection[key].video.style.gridColumnStart = column;

      ii++;
    }
  }
};

function addMessageHandler()
{
  signaling.onmessage = async (message) => {
    const data = JSON.parse(message.data);

    if (!data)
    {
      return;
    }

    const {message_type, content, peer_id} = data;
    try
    {
      if (message_type === MESSAGE_TYPE.SERVER && content === 'your id')
      {
        host_id = peer_id;
      }
      else if (message_type === MESSAGE_TYPE.VOLUME)
      {
        peerConnection[peer_id].set_volume(content.volume);
      }
      else
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
          pc.addIceCandidate(content).then(()      => { console.log('AddIceCandidate success.'); },
                                           (error) => { console.log(`Failed to add ICE candidate: ${error.toString()}`); });
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
        else if (message_type === MESSAGE_TYPE.SERVER)
        {
          if (content === 'delete')
          {
            peerConnection[peer_id].close();
            delete peerConnection[peer_id];

            updateRemoteViewLayout();
          }
        }
      }
    }
    catch (err)
    {
      console.log(err);
    }
  }
};
function waitForOpenConnection(socket)
{
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

async function sendMessage(message)
{
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

async function createAndSendOffer(pc)
{
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  sendMessage({
    message_type : MESSAGE_TYPE.SDP,
    content : offer,
  });
}

function showChatRoom()
{
  document.getElementById('start').style.display     = 'none';
  document.getElementById('chat-room').style.display = '';
}

function showLandingPage()
{
  document.getElementById('start').style.display     = '';
  document.getElementById('chat-room').style.display = 'none';
}

function shareFile()
{
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

      channel.onclose = () => { closeDialog(); };
    }
  }
};

function closeDialog()
{
  document.getElementById('select-file-input').value          = '';
  document.getElementById('select-file-dialog').style.display = 'none';
}

function downloadFile(blob, fileName)
{
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

document.getElementById('start-button').addEventListener('click', onStartButtonClick);

async function onStartButtonClick()
{
  if (code)
  {
    startChat();
    document.getElementById('code-input').value = null;
  }
}

document.getElementById("code-input").addEventListener("keyup", onCodeInputKeyup);

function onCodeInputKeyup(event)
{
  if (event.key !== "Enter")
  {
    return;
  }

  document.getElementById("start-button").click();
  event.preventDefault(); // No need to `return false;`.
}

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
    userAudioStream.getTracks().forEach(track => { track.enabled = true; });

    icon.classList.toggle('fa-microphone');
    button.style.backgroundColor = ''
  }
  else
  {
    userAudioStream.getTracks().forEach(track => { track.enabled = false; });
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
    userVideoStream.getTracks().forEach(track => { track.enabled = true; });
    icon.classList.toggle('fa-video');
    button.style.backgroundColor = ''
  }
  else
  {
    userVideoStream.getTracks().forEach(track => { track.enabled = false; });
    icon.classList.toggle('fa-video-slash');
    button.style.backgroundColor = '#97a2ab'
  }
});

document.getElementById('share-button').addEventListener('click', async () => {
  let button        = document.getElementById('share-button');
  let icon          = button.children[0];
  let current_value = icon.classList.value;

  if (current_value.includes('slash'))
  {
    if (senders.length != 0)
    {
      senders.find(sender => sender.track.kind === 'video')
          .replaceTrack(userVideoStream.getTracks().find(track => track.kind === 'video'));
    }
    document.getElementById('self-view').srcObject = userVideoStream;
    displayMediaStream                             = null;

    icon.classList.toggle('fa-eye');
  }
  else
  {
    displayMediaStream = await navigator.mediaDevices.getDisplayMedia();
    if (senders.length != 0)
    {
      senders.find(sender => sender.track.kind === 'video').replaceTrack(displayMediaStream.getTracks()[0]);
    }

    // show what you are showing in your "self-view" video.
    document.getElementById('self-view').srcObject = displayMediaStream;

    icon.classList.toggle('fa-eye-slash');
    // button.style.backgroundColor = '#97a2ab'
  }
});

document.getElementById('share-file-button')
    .addEventListener('click', () => { document.getElementById('select-file-dialog').style.display = 'block'; });

document.getElementById('cancel-button').addEventListener('click', () => { closeDialog(); });

document.getElementById('select-file-input').addEventListener('change', (event) => {
  file                                          = event.target.files[0];
  document.getElementById('ok-button').disabled = !file;
});

document.getElementById('ok-button').addEventListener('click', () => { shareFile(); });
})();

document.getElementById('self-view')
    .addEventListener("mousedown", () => {window.addEventListener("mousemove", moveSelfView, true)}, false);
window.addEventListener("mouseup", () => {window.removeEventListener("mousemove", moveSelfView, true)}, false);

document.getElementById('self-view').addEventListener("dblclick", () => {
  element = document.getElementById('self-view-parent');

  element.style.gridArea = '1 / 1 / 2 / 2'

  element.style.position = '';
  element.style.width    = '';
  element.style.top      = '';
  element.style.left     = '';

  element.is_docked = true;
}, false);

function handleResize(entries)
{
  for (let entry of entries)
  {
    resizeMinimapFromElement(entry)
  }
}

function resizeMinimapFromElement(e)
{
  if (e.target === document.getElementById('self-view-parent'))
  {
    if (e.target.is_docked == true)
    {
      let new_size = e.contentRect;
      let room_map = document.getElementById('room-map');

      room_map.style.width  = new_size.width + "px"
      room_map.style.height = new_size.height + "px"
    }
  }
};

function moveSelfView(e)
{
  element           = document.getElementById('self-view-parent');
  element.is_docked = false;

  original_size          = element.getBoundingClientRect();
  element.style.position = "absolute";
  element.style.width    = original_size.width + "px";

  element.style.top  = (e.clientY - (original_size.height / 2)) + "px";
  element.style.left = (e.clientX - (original_size.width / 2)) + "px";
};