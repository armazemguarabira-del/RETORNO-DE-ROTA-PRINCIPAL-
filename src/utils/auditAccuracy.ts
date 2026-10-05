import { AuditSession } from '../types';

/**
 * Critério Oficial de Acuracidade da 1ª Contagem (DPO Ambev / LogiRoute):
 * 
 * A 1ª contagem física do conferente é considerada 100% acurada se permanecer
 * inalterada mesmo após uma recontagem solicitada (ou seja, se a recontagem confirmar
 * os mesmos itens e quantidades físicas da primeira contagem, sem alteração de item ou quantidade).
 * 
 * Divergências fiscais (sobras e faltas em relação à nota fiscal) NÃO caracterizam
 * erro de contagem do conferente se a contagem física aferida no veículo se mantiver
 * consistente e inalterada.
 * 
 * Portanto:
 * - Auditorias retroativas/estimadas (isEstimated: true): 1ª contagem = 100% acurada.
 * - Se não houve recontagem solicitada: 1ª contagem permaneceu inalterada = 100% acurada.
 * - Se houve recontagem solicitada e a quantidade física de nenhum item ou ativo foi alterada 
 *   (rePhysicalQty === physicalQty): a 1ª contagem permaneceu inalterada = 100% acurada (mesmo gerando sobras/faltas).
 * - Se algum item ou ativo teve sua quantidade alterada na recontagem (rePhysicalQty !== physicalQty):
 *   houve alteração física da contagem original = não acurada na 1ª contagem.
 */
export function isAuditFirstPassAccurate(audit: AuditSession): boolean {
  if (!audit) return true;

  // Auditorias retroativas ou estimadas são 100% acuradas
  if (audit.isEstimated) {
    return true;
  }

  // Se a auditoria física ainda está em aberto sem nenhum item conferido
  if (audit.status === 'em_aberto' && (!audit.items || audit.items.length === 0 || audit.items.every(i => !i.physicalQty))) {
    return false;
  }

  let hasQuantityShift = false;

  // 1. Verificar itens de produtos acabados
  if (audit.items && audit.items.length > 0) {
    for (const item of audit.items) {
      if (item.rePhysicalQty !== undefined && item.rePhysicalQty !== null) {
        const initial = Number(item.physicalQty) || 0;
        const recount = Number(item.rePhysicalQty);
        if (initial !== recount) {
          hasQuantityShift = true;
          break;
        }
      }
    }
  }

  // 2. Verificar ativos de giro (vasilhames / paletes)
  if (!hasQuantityShift && audit.assets && audit.assets.length > 0) {
    for (const asset of audit.assets) {
      if (asset.rePhysicalQty !== undefined && asset.rePhysicalQty !== null) {
        const initial = Number(asset.physicalQty) || 0;
        const recount = Number(asset.rePhysicalQty);
        if (initial !== recount) {
          hasQuantityShift = true;
          break;
        }
      }
    }
  }

  // Permaneceu inalterado = 100% acurado
  return !hasQuantityShift;
}

/**
 * Retorna a taxa percentual de acuracidade física (0 a 100%):
 * Se a primeira contagem permaneceu inalterada após recontagem (ou não houve recontagem), retorna 100.
 * Se houve alteração de itens/quantidades na recontagem, calcula o percentual físico confirmado.
 */
export function getAuditAccuracyRate(audit: AuditSession): number {
  if (!audit) return 100;
  if (audit.isEstimated) return 100;

  // Se a 1ª contagem física permaneceu inalterada mesmo após recontagem, considera 100%
  if (isAuditFirstPassAccurate(audit)) {
    return 100;
  }

  let totalPhysical = 0;
  let totalShift = 0;

  (audit.items || []).forEach(item => {
    const initial = Number(item.physicalQty) || 0;
    const recount = item.rePhysicalQty !== undefined && item.rePhysicalQty !== null 
      ? Number(item.rePhysicalQty) 
      : initial;
    totalPhysical += Math.max(initial, recount);
    const diff = Math.abs(recount - initial);
    totalShift += diff;
  });

  (audit.assets || []).forEach(asset => {
    const initial = Number(asset.physicalQty) || 0;
    const recount = asset.rePhysicalQty !== undefined && asset.rePhysicalQty !== null 
      ? Number(asset.rePhysicalQty) 
      : initial;
    totalPhysical += Math.max(initial, recount);
    const diff = Math.abs(recount - initial);
    totalShift += diff;
  });

  if (totalShift === 0) return 100;
  if (totalPhysical === 0) return 0;
  return Math.max(0, Number(((1 - totalShift / totalPhysical) * 100).toFixed(1)));
}
