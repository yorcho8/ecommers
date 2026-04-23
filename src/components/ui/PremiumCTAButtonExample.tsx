import React from "react";
import PremiumCTAButton from "./PremiumCTAButton";

export default function PremiumCTAButtonExample() {
  return (
    <div className="flex flex-wrap items-center gap-3 p-4">
      <PremiumCTAButton variant="primary" size="lg">
        Agregar al carrito
      </PremiumCTAButton>

      <PremiumCTAButton variant="secondary" size="md">
        Ver productos
      </PremiumCTAButton>

      <PremiumCTAButton loading size="md">
        Comprar ahora
      </PremiumCTAButton>

      <PremiumCTAButton disabled size="sm">
        Sin stock
      </PremiumCTAButton>
    </div>
  );
}
