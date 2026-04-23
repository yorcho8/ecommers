/// <reference types="astro/client" />
/// <reference types="vite-plugin-pwa/info" />
/// <reference types="vite-plugin-pwa/client" />

// DEFINICIONES MANUALES DE RESPALDO
// (Por si TypeScript no detecta las referencias automáticas)

declare module 'virtual:pwa-info' {
    export const pwaInfo: {
      webManifest: {
        href: string;
        linkTag: string;
      };
    };
  }
  
  declare module 'virtual:pwa-register' {
    export interface RegisterSWOptions {
      immediate?: boolean;
      onNeedRefresh?: () => void;
      onOfflineReady?: () => void;
      onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void;
      onRegisteredSW?: (swUrl: string, registration: ServiceWorkerRegistration | undefined) => void;
      onRegisterError?: (error: any) => void;
    }
  
    export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>;
  }

  declare namespace App {
    interface Locals {
      user?: {
        userId?: number;
        correo?: string;
        nombre?: string;
        apellidoPaterno?: string;
        rol?: string;
        mustChangePassword?: boolean;
        exp?: number;
        iat?: number;
        iph?: string | null;
      } | null;
      isAuthenticated?: boolean;
      cspNonce?: string;
    }
  }