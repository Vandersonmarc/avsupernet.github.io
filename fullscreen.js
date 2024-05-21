// Função para abrir o vídeo em tela cheia
function openFullscreen(elem) {
  if (elem.requestFullscreen) {
    elem.requestFullscreen();
  } else if (elem.mozRequestFullScreen) { /* Firefox */
    elem.mozRequestFullScreen();
  } else if (elem.webkitRequestFullscreen) { /* Chrome, Safari & Opera */
    elem.webkitRequestFullscreen();
  } else if (elem.msRequestFullscreen) { /* IE/Edge */
    elem.msRequestFullscreen();
  }
}

// Evento para abrir vídeos em tela cheia em dispositivos Android
document.addEventListener('DOMContentLoaded', () => {
  var video = document.querySelector('video');
  if (/Android/i.test(navigator.userAgent)) {
    video.addEventListener('play', () => {
      openFullscreen(video);
    });
  }

  // Utilizando as classes do Bootstrap para o efeito de escala nos botões
  document.querySelectorAll('.btn-custom').forEach(button => {
    button.addEventListener('mouseover', () => {
      button.classList.add('scale-up');
    });
    button.addEventListener('mouseout', () => {
      button.classList.remove('scale-up');
    });
  });

  // Funcionalidade do acordeão utilizando componentes do Bootstrap
  const accordions = document.querySelectorAll('.accordion');
  accordions.forEach(acc => {
    acc.addEventListener('click', () => {
      let panel = acc.nextElementSibling;
      if (panel.style.display === 'block') {
        panel.style.display = 'none';
      } else {
        panel.style.display = 'block';
      }
      acc.classList.toggle('active');
    });
  });

  // Botão de Retorno ao Topo utilizando classes do Bootstrap
  const topButton = document.createElement('button');
  topButton.id = 'topBtn';
  topButton.innerText = 'Topo';
  topButton.className = 'btn btn-secondary';
  topButton.style.display = 'none';
  document.body.appendChild(topButton);

  window.onscroll = function() {
    if (document.body.scrollTop > 20 || document.documentElement.scrollTop > 20) {
      topButton.style.display = 'block';
    } else {
      topButton.style.display = 'none';
    }
  };

  topButton.onclick = function() {
    document.body.scrollTop = 0;
    document.documentElement.scrollTop = 0;
  };

  // Efeito Fade-in ao entrar na viewport utilizando classes do Bootstrap
  const faders = document.querySelectorAll('.fade-in');
  const appearOptions = {
    threshold: 0.1,
    rootMargin: "0px 0px -100px 0px"
  };

  const appearOnScroll = new IntersectionObserver(function(entries, appearOnScroll) {
    entries.forEach(entry => {
      if (!entry.isIntersecting) {
        return;
      } else {
        entry.target.classList.add('appear');
        appearOnScroll.unobserve(entry.target);
      }
    });
  }, appearOptions);

  faders.forEach(fader => {
    appearOnScroll.observe(fader);
  });
});