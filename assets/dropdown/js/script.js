function openFullscreen(elem) {
  if (elem.requestFullscreen) {
    elem.requestFullscreen();
  } else if (elem.mozRequestFullScreen) { 
    elem.mozRequestFullScreen();
  } else if (elem.webkitRequestFullscreen) { 
    elem.webkitRequestFullscreen();
  } else if (elem.msRequestFullscreen) { 
    elem.msRequestFullscreen();
  }
}

document.addEventListener('DOMContentLoaded', function() {
  var video = document.getElementById('meuVideo');
  if (/Android/i.test(navigator.userAgent)) {
    video.addEventListener('play', function() {
      openFullscreen(video);
    });
  }
});