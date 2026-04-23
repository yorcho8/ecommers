// =========================================
// TIMELINE SLIDER - GRUPO ORTIZ
// =========================================

(function() {
  'use strict';

  let currentSlide = 0;
  let isAnimating = false;
  let autoplayInterval = null;
  let timelineItems = [];
  let totalSlides = 0;

  // Inicialización del timeline
  function initTimeline() {
    const timelineTrack = document.querySelector('.timeline-track');
    const prevBtn = document.querySelector('.timeline-prev');
    const nextBtn = document.querySelector('.timeline-next');
    const indicatorsContainer = document.querySelector('.timeline-indicators');

    if (!timelineTrack) return;

    timelineItems = document.querySelectorAll('.timeline-item');
    totalSlides = timelineItems.length;

    if (totalSlides === 0) return;

    // Crear indicadores
    createIndicators(indicatorsContainer);

    // Establecer primer slide como activo
    updateSlide(0, false);

    // Event listeners para navegación
    if (prevBtn) {
      prevBtn.addEventListener('click', () => navigateSlide('prev'));
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => navigateSlide('next'));
    }

    // Soporte para teclado
    document.addEventListener('keydown', handleKeyboard);

    // Soporte para touch/swipe en móviles
    initTouchSupport(timelineTrack);

    // Autoplay
    startAutoplay();

    // Pausar autoplay al hacer hover
    const sliderWrapper = document.querySelector('.timeline-slider-wrapper');
    if (sliderWrapper) {
      sliderWrapper.addEventListener('mouseenter', stopAutoplay);
      sliderWrapper.addEventListener('mouseleave', startAutoplay);
    }
  }

  // Crear indicadores
  function createIndicators(container) {
    if (!container) return;

    container.innerHTML = '';

    for (let i = 0; i < totalSlides; i++) {
      const indicator = document.createElement('div');
      indicator.className = 'timeline-indicator';
      indicator.setAttribute('data-index', i);
      indicator.addEventListener('click', () => goToSlide(i));
      container.appendChild(indicator);
    }
  }

  // Navegar entre slides
  function navigateSlide(direction) {
    if (isAnimating) return;

    let newIndex = currentSlide;

    if (direction === 'next') {
      newIndex = (currentSlide + 1) % totalSlides;
    } else if (direction === 'prev') {
      newIndex = (currentSlide - 1 + totalSlides) % totalSlides;
    }

    goToSlide(newIndex);
  }

  // Ir a un slide específico
  function goToSlide(index) {
    if (isAnimating || index === currentSlide || index < 0 || index >= totalSlides) {
      return;
    }

    updateSlide(index, true);
  }

  // Actualizar slide actual
  function updateSlide(index, animate = true) {
    isAnimating = true;

    const timelineTrack = document.querySelector('.timeline-track');
    const progressFill = document.querySelector('.timeline-progress-fill');
    const indicators = document.querySelectorAll('.timeline-indicator');

    // Remover clase active de todos los items
    timelineItems.forEach(item => item.classList.remove('active'));

    // Agregar clase active al nuevo item
    if (timelineItems[index]) {
      timelineItems[index].classList.add('active');
    }

    // Actualizar posición del track
    const offset = -index * 100;
    if (timelineTrack) {
      timelineTrack.style.transform = `translateX(${offset}%)`;
    }

    // Actualizar barra de progreso
    const progress = ((index + 1) / totalSlides) * 100;
    if (progressFill) {
      progressFill.style.width = `${progress}%`;
    }

    // Actualizar indicadores
    indicators.forEach((indicator, i) => {
      indicator.classList.toggle('active', i === index);
    });

    currentSlide = index;

    // Resetear flag de animación
    setTimeout(() => {
      isAnimating = false;
    }, animate ? 500 : 0);
  }

  // Soporte para teclado
  function handleKeyboard(e) {
    if (e.key === 'ArrowLeft') {
      navigateSlide('prev');
    } else if (e.key === 'ArrowRight') {
      navigateSlide('next');
    }
  }

  // Soporte para touch/swipe
  function initTouchSupport(element) {
    if (!element) return;

    let startX = 0;
    let startY = 0;
    let isDragging = false;

    element.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      isDragging = true;
      stopAutoplay();
    }, { passive: true });

    element.addEventListener('touchmove', (e) => {
      if (!isDragging) return;

      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;
      const diffX = startX - currentX;
      const diffY = startY - currentY;

      // Solo procesar si el movimiento es más horizontal que vertical
      if (Math.abs(diffX) > Math.abs(diffY)) {
        e.preventDefault();
      }
    }, { passive: false });

    element.addEventListener('touchend', (e) => {
      if (!isDragging) return;

      const endX = e.changedTouches[0].clientX;
      const diffX = startX - endX;

      // Mínimo 50px de swipe para cambiar
      if (Math.abs(diffX) > 50) {
        if (diffX > 0) {
          navigateSlide('next');
        } else {
          navigateSlide('prev');
        }
      }

      isDragging = false;
      startAutoplay();
    });
  }

  // Autoplay
  function startAutoplay() {
    stopAutoplay(); // Limpiar cualquier intervalo existente

    autoplayInterval = setInterval(() => {
      navigateSlide('next');
    }, 5000); // Cambiar cada 5 segundos
  }

  function stopAutoplay() {
    if (autoplayInterval) {
      clearInterval(autoplayInterval);
      autoplayInterval = null;
    }
  }

  // Reiniciar en resize
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      updateSlide(currentSlide, false);
    }, 250);
  });

  // Limpiar al salir
  window.addEventListener('beforeunload', () => {
    stopAutoplay();
    document.removeEventListener('keydown', handleKeyboard);
  });

  // Inicializar cuando el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTimeline);
  } else {
    initTimeline();
  }

  // Soporte para Astro View Transitions
  document.addEventListener('astro:page-load', () => {
    currentSlide = 0;
    isAnimating = false;
    stopAutoplay();
    initTimeline();
  });

})();