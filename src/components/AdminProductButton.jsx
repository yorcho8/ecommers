import React, { useEffect, useState } from 'react';
import AddProductForm from './AddProductForm';
import '../styles/AdminProductButton.css';
import '../styles/AddProductForm.css';

export default function AdminProductButton() {
  console.log('AdminProductButton component executing (client)?');
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    const checkAdmin = async () => {
      try {
        const response = await fetch('/api/me', { credentials: 'include' });

        const data = await response.json();

        if (data.success && data.user?.rol === 'admin') {
          setIsAdmin(true);
        } else {
          setIsAdmin(false);
        }
      } catch (error) {
        console.error(' AdminProductButton: Error en checkAdmin:', error);
      } finally {
        setLoading(false);
      }
    };

    checkAdmin();
  }, []);

  if (loading || !isAdmin) {
    return null; 
  }

  return (
    <>
      <div className="admin-product-button-wrapper">
        <button 
          className="admin-product-btn"
          onClick={() => setShowModal(true)}
          title="Agregar nuevo producto (solo administrador)"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Agregar Producto
        </button>
      </div>

      {}
      {showModal && (
        <div className="admin-modal-overlay" onClick={() => setShowModal(false)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-header">
              <h2>Agregar Nuevo Producto</h2>
              <button 
                className="admin-modal-close"
                onClick={() => setShowModal(false)}
              >
                ✕
              </button>
            </div>
            
            <div className="admin-modal-body">
              <AddProductForm />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
