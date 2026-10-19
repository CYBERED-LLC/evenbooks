import 'server-only';
import { createPaymentProcessorFromEnv, type PaymentProcessorClient } from '@evenbooks/integrations';
import { platformFeeConfigFromEnv, type PlatformFeeConfig } from '@evenbooks/domain';
import type { ProcessorDeps } from '@evenbooks/services';

declare global {
  var __evenbooksProcessor: PaymentProcessorClient | undefined;
}

/** One client per process: the fixture driver keeps sessions and accounts in memory during development. */
export function getProcessor(): PaymentProcessorClient {
  if (!globalThis.__evenbooksProcessor) globalThis.__evenbooksProcessor = createPaymentProcessorFromEnv();
  return globalThis.__evenbooksProcessor;
}

export function feeConfig(): PlatformFeeConfig {
  return platformFeeConfigFromEnv();
}

export function processorDeps(): ProcessorDeps {
  return { client: getProcessor(), feeConfig: feeConfig() };
}

/** Capabilities of this server that the UI should reflect (see SessionDto.features). */
export function serverFeatures(): { onlinePayments: boolean; stripeAccountLinking: boolean } {
  const p = getProcessor();
  return { onlinePayments: p.driver !== 'off', stripeAccountLinking: p.supportsLinking };
}
