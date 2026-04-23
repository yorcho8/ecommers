document.addEventListener("DOMContentLoaded", () => {

  /* =========================
     DATA
  ========================= */
  const productsData = window.PRODUCTS_DATA || {};

  /* =========================
     ELEMENTOS DOM
  ========================= */
  const nextButton = document.getElementById("next");
  const prevButton = document.getElementById("prev");
  const carousel = document.querySelector(".carousel");
  const listHTML = document.querySelector(".carousel .list");

  let unAcceptClick;
  let currentVideoElement = null;

  /* =========================
     CREAR CONTENEDOR DE VIDEOS (sin src — lazy)
  ========================= */
  function createVideoContainer() {
    if (document.querySelector('.video-background-container')) return;

    const videoContainer = document.createElement('div');
    videoContainer.className = 'video-background-container';

    Object.entries(productsData).forEach(([productName, videoSrc]) => {
      const video = document.createElement('video');
      video.className = 'video-background';
      video.dataset.product = productName;
      // ✅ NO asignamos src aquí — se asigna solo cuando el producto se activa
      video.dataset.src = videoSrc;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      // ✅ preload none: el browser no descarga nada hasta que lo necesitemos
      video.preload = 'none';

      videoContainer.appendChild(video);
    });

    document.body.insertBefore(videoContainer, document.body.firstChild);
  }

  /* =========================
     CAMBIAR VIDEO DE FONDO (carga lazy al activar)
  ========================= */
  function changeBackgroundVideo(productName) {
    const targetVideo = document.querySelector(`.video-background[data-product="${productName}"]`);

    if (!targetVideo) {
      console.warn(`No se encontró video para: ${productName}`);
      return;
    }

    if (currentVideoElement === targetVideo) return;

    const previousVideo = currentVideoElement;

    // ✅ Ocultar video anterior
    if (previousVideo) {
      previousVideo.classList.remove('active');
      setTimeout(() => {
        if (previousVideo !== currentVideoElement) {
          previousVideo.pause();
          // ✅ Liberar memoria: quitar src del video inactivo si ya se cargó
          // (opcional — comentar si se prefiere mantenerlo en cache)
          // previousVideo.src = '';
          // previousVideo.load();
        }
      }, 400);
    }

    // ✅ LAZY LOAD: asignar src solo en este momento, la primera vez
    if (!targetVideo.src || targetVideo.src === window.location.href) {
      targetVideo.src = targetVideo.dataset.src;
      targetVideo.load();
    }

    targetVideo.currentTime = 0;
    targetVideo.loop = true;

    // ✅ Esperar a que tenga suficientes datos antes de mostrar
    const tryPlay = () => {
      const playPromise = targetVideo.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            setTimeout(() => targetVideo.classList.add('active'), 50);
          })
          .catch(err => {
            console.warn('Error al reproducir video:', err);
            // Reintentar al primer click/touch del usuario
            document.addEventListener('click', () => {
              targetVideo.play().catch(() => {});
            }, { once: true });
            document.addEventListener('touchstart', () => {
              targetVideo.play().catch(() => {});
            }, { once: true });
          });
      }
    };

    // Si el video ya tiene datos suficientes, reproducir directo
    if (targetVideo.readyState >= 3) {
      tryPlay();
    } else {
      targetVideo.addEventListener('canplay', tryPlay, { once: true });
    }

    currentVideoElement = targetVideo;
  }

  /* =========================
     GUARDAR POSICIÓN DEL CARRUSEL
  ========================= */
  function saveCarouselPosition() {
    const items = document.querySelectorAll(".carousel .list .item");
    const activeItem = items[1];
    if (!activeItem) return;
    const topicEl = activeItem.querySelector(".topic");
    if (!topicEl) return;
    const name = topicEl.getAttribute("data-name") || topicEl.innerText.trim();
    sessionStorage.setItem("carousel-active-product", name);
  }

  /* =========================
     RESTAURAR POSICIÓN DEL CARRUSEL
  ========================= */
  function restoreCarouselPosition() {
    const savedName = sessionStorage.getItem("carousel-active-product");
    if (!savedName) return;

    const items = document.querySelectorAll(".carousel .list .item");
    let targetIndex = -1;

    items.forEach((item, i) => {
      const topicEl = item.querySelector(".topic");
      if (!topicEl) return;
      const name = topicEl.getAttribute("data-name") || topicEl.innerText.trim();
      if (name === savedName) targetIndex = i;
    });

    if (targetIndex <= 0) return;

    const steps = targetIndex - 1;
    for (let i = 0; i < steps; i++) {
      const currentItems = listHTML.querySelectorAll(".item");
      listHTML.appendChild(currentItems[0]);
    }
  }

  /* =========================
     SLIDER (MOTOR PRINCIPAL)
  ========================= */
  if (nextButton) nextButton.onclick = () => showSlider("next");
  if (prevButton) prevButton.onclick = () => showSlider("prev");

  function showSlider(type) {
    if (nextButton) nextButton.style.pointerEvents = "none";
    if (prevButton) prevButton.style.pointerEvents = "none";

    carousel.classList.remove("next", "prev");
    void carousel.offsetWidth;

    const items = document.querySelectorAll(".carousel .list .item");

    if (type === "next") {
      listHTML.appendChild(items[0]);
      carousel.classList.add("next");
    } else {
      listHTML.prepend(items[items.length - 1]);
      carousel.classList.add("prev");
    }

    clearTimeout(unAcceptClick);
    unAcceptClick = setTimeout(() => {
      if (nextButton) nextButton.style.pointerEvents = "auto";
      if (prevButton) prevButton.style.pointerEvents = "auto";
      updateActiveProduct();
    }, 300);
  }

  /* =========================
     PRODUCTO ACTIVO & VIDEO
  ========================= */
  function updateActiveProduct() {
    const activeItem = document.querySelector(".carousel .list .item:nth-child(2)");
    if (!activeItem) return;

    const topicElement = activeItem.querySelector(".topic");
    if (!topicElement) return;

    const productName = topicElement.getAttribute('data-name') || topicElement.innerText.trim();
    changeBackgroundVideo(productName);
  }

  /* =========================================
     MOUSE DRAG
  ========================================= */
  let isDragging = false;
  let startX = 0;
  const DRAG_THRESHOLD = 50;

  carousel.addEventListener("mousedown", (e) => {
    if (carousel.classList.contains("showDetail") || e.target.closest('button')) return;
    isDragging = true;
    startX = e.clientX;
    carousel.classList.add("dragging");
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    e.preventDefault();
  });

  window.addEventListener("mouseup", (e) => {
    if (!isDragging) return;
    isDragging = false;
    carousel.classList.remove("dragging");

    const endX = e.clientX;
    const diff = endX - startX;

    if (Math.abs(diff) > DRAG_THRESHOLD) {
      if (diff > 0) {
        showSlider("prev");
      } else {
        showSlider("next");
      }
    }
  });

  /* =========================
     TOUCH SWIPE (Móvil)
  ========================= */
  let touchStartX = 0;
  let touchEndX = 0;
  const SWIPE_THRESHOLD = 50;

  carousel.addEventListener('touchstart', (e) => {
    if (carousel.classList.contains("showDetail")) return;
    touchStartX = e.changedTouches[0].screenX;
  }, { passive: true });

  carousel.addEventListener('touchend', (e) => {
    if (carousel.classList.contains("showDetail")) return;
    touchEndX = e.changedTouches[0].screenX;
    handleGesture();
  }, { passive: true });

  function handleGesture() {
    if (touchEndX < touchStartX - SWIPE_THRESHOLD) showSlider('next');
    if (touchEndX > touchStartX + SWIPE_THRESHOLD) showSlider('prev');
  }

  /* =========================
     INICIALIZAR
  ========================= */
  createVideoContainer();
  restoreCarouselPosition();
  setTimeout(() => {
    updateActiveProduct();
    sessionStorage.removeItem("carousel-active-product");
  }, 100);

  /* =========================
     NAVEGACIÓN CON TRANSICIÓN
  ========================= */
  const seeMoreButtons = document.querySelectorAll(".seeMore");

  seeMoreButtons.forEach(button => {
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      const link = button.getAttribute('href');

      saveCarouselPosition();
      carousel.classList.add('transition-active');

      try {
        await new Promise(resolve => setTimeout(resolve, 1350));
        window.location.href = link;
      } catch (error) {
        console.error("Error al precargar la página:", error);
        setTimeout(() => { window.location.href = link; }, 1350);
      }
    });
  });

});