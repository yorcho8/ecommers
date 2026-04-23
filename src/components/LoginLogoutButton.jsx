import React, { useEffect, useRef, useState } from 'react';
import '../styles/LoginLogoutButton.css';

/**
 * @param {{ currentLang?: string; initialUser?: { nombre?: string } | null }} props
 */
export default function LoginLogoutButton({ currentLang = 'es', initialUser = null }) {
  const [isLoggedIn, setIsLoggedIn] = useState(Boolean(initialUser));
  const [userName, setUserName] = useState(initialUser?.nombre || '');
  const [openMenu, setOpenMenu] = useState(false);
  const menuRef = useRef(null);
  const checkSessionRef = useRef(async () => {});

  useEffect(() => {
    let isMounted = true;

    const checkSession = async () => {
      try {
        const response = await fetch('/api/me', { credentials: 'include' });
        const data = await response.json();

        if (!isMounted) return;

        if (response.ok && data.success && data.user) {
          setIsLoggedIn(true);
          setUserName(data.user.nombre || '');
        } else {
          setIsLoggedIn(false);
          setUserName('');
        }
      } catch (error) {
        if (!isMounted) return;
        console.error('Error verificando sesión:', error);
      }
    };

    checkSessionRef.current = checkSession;

    checkSession();

    const refreshOnVisibility = () => {
      if (document.visibilityState === 'visible') {
        checkSessionRef.current();
      }
    };

    const refreshOnFocus = () => {
      checkSessionRef.current();
    };

    window.addEventListener('pageshow', refreshOnFocus);
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnVisibility);

    return () => {
      isMounted = false;
      window.removeEventListener('pageshow', refreshOnFocus);
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnVisibility);
    };
  }, []);

  useEffect(() => {
    const closeMenuOnOutsideClick = (event) => {
      // Use closest() — more reliable than contains() for SVG children and cross-frame scenarios
      if (event.target instanceof Element && event.target.closest('.account-menu')) return;
      setOpenMenu(false);
    };

    document.addEventListener('click', closeMenuOnOutsideClick);
    return () => document.removeEventListener('click', closeMenuOnOutsideClick);
  }, []);

  const handleLogout = async () => {
    try {
      const response = await fetch('/api/logout', {
        method: 'POST',
        credentials: 'include'
      });

      const data = await response.json();

      if (data.success) {
        setIsLoggedIn(false);
        setUserName('');
        
        window.location.href = `/${currentLang}/login`;
      } else {
        alert('Error al cerrar sesión');
      }
    } catch (error) {
      console.error('Error en logout:', error);
      alert('Error de conexión');
    }
  };

  if (isLoggedIn) {
    return (
      <div className="account-menu" ref={menuRef}>
        <button
          className="nav-account-btn"
          type="button"
          title={`Mi cuenta (${userName})`}
          onClick={() => setOpenMenu((prev) => !prev)}
          aria-expanded={openMenu}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 21a8 8 0 0 0-16 0"></path>
            <circle cx="12" cy="7" r="4"></circle>
          </svg>
          Mi cuenta
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>

        {openMenu && (
          <div className="account-dropdown">
            <div className="account-dropdown-head">
              <p className="account-dropdown-title">Cuenta de cliente</p>
              <p className="account-dropdown-subtitle">{userName || 'Mi perfil'}</p>
            </div>
            <a href={`/${currentLang}/mi-cuenta#info-personal`} className="account-dropdown-item" onClick={() => setOpenMenu(false)}>
              Perfil
            </a>
            <a href={`/${currentLang}/mi-cuenta#mis-pedidos`} className="account-dropdown-item" onClick={() => setOpenMenu(false)}>
              Pedidos
            </a>
            <a href={`/${currentLang}/mi-cuenta#mis-tarjetas`} className="account-dropdown-item" onClick={() => setOpenMenu(false)}>
              Metodos de pago
            </a>
            <a href={`/${currentLang}/favoritos`} className="account-dropdown-item" onClick={() => setOpenMenu(false)}>
              ♥ Favoritos
            </a>
            <button type="button" className="account-dropdown-item danger" onClick={handleLogout}>
              Cerrar sesión
            </button>
          </div>
        )}
      </div>
    );
  } else {
    return (
      <a
        href={`/${currentLang}/login`}
        className="nav-login-btn"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
          <polyline points="10 17 15 12 10 7"></polyline>
          <line x1="15" y1="12" x2="3" y2="12"></line>
        </svg>
        Iniciar sesión
      </a>
    );
  }
}
