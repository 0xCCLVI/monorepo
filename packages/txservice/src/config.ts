import { Type, Static } from "@sinclair/typebox";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { parseUnits } from "ethers/lib/utils";
import {
  TIntegerString,
  TUrl,
} from "@connext/nxtp-utils";

const ajv = addFormats(new Ajv(), [
  "date-time",
  "time",
  "date",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "uuid",
  "uri-template",
  "json-pointer",
  "relative-json-pointer",
  "regex",
])
  .addKeyword("kind")
  .addKeyword("modifier");

const TransactionServiceConfigSchema = Type.Object({
  /// GAS
  // % to bump gas by from gas station quote.
  gasInitialBumpPercent: Type.Number(),
  // % to bump gas by when tx confirmation times out.
  gasReplacementBumpPercent: Type.Number(),
  // Gas shouldn't ever exceed this amount.
  gasLimit: TIntegerString,
  // Minimum gas price.
  gasMinimum: TIntegerString,
  // Hardcoded initial value for gas. This shouldn't be used normally - only temporarily
  // in the event that a gas station is malfunctioning.
  chainInitialGas: Type.Dict(TIntegerString),

  /// CONFIRMATIONS
  // The multiplier by which we extend our timeout period if a tx has at least 1 confirmation.
  confirmationTimeoutExtensionMultiplier: Type.Number(),
  // Default number of confirmations we require for a tx.
  defaultConfirmationsRequired: Type.Number(),
  // Default amount of time (ms) to wait before a confirmation polling period times out.
  defaultConfirmationTimeout: Type.Number(),
  // The amount of time (ms) to wait before a confirmation polling period times out,
  // indicating we should resubmit tx with higher gas if the tx is not confirmed.
  confirmationTimeouts: Type.Dict(Type.Number()),
  // Number of confirmations needed for each chain, specified by chain Id.
  chainConfirmations: Type.Dict(Type.Number()),

  /// RPC PROVIDERS
  // RPC provider call max attempts - how many attempts / retries will we do upon failure?
  rpcProviderMaxRetries: Type.Number(),
});

export type TransactionServiceConfig = Static<typeof TransactionServiceConfigSchema>;
export const validateTransactionServiceConfig = ajv.compile(TransactionServiceConfigSchema);

// Set up the default configuration for TransactionServiceConfig.
export const DEFAULT_CONFIG: TransactionServiceConfig = {
  gasInitialBumpPercent: 30,
  // From ethers docs:
  // Generally, the new gas price should be about 50% + 1 wei more, so if a gas price
  // of 10 gwei was used, the replacement should be 15.000000001 gwei.
  gasReplacementBumpPercent: 20,
  gasLimit: parseUnits("1500", "gwei").toString(),
  gasMinimum: parseUnits("5", "gwei").toString(),
  chainInitialGas: {},

  defaultConfirmationTimeout: 45_000,
  confirmationTimeoutExtensionMultiplier: 4,
  defaultConfirmationsRequired: 10,
  confirmationTimeouts: {},
  chainConfirmations: {},

  rpcProviderMaxRetries: 5,
} as TransactionServiceConfig;
const valid = validateTransactionServiceConfig(DEFAULT_CONFIG);
if (!valid) {
  console.error(`Default configuration for txservice is invalid: ${JSON.stringify(DEFAULT_CONFIG, null, 2)}`);
  throw new Error(validateTransactionServiceConfig.errors?.map((err) => err.message).join(","));
}

export const ProviderConfigSchema = Type.Object({
  // URL string.
  url: TUrl,

  // Auth header params, if needed.
  user: Type.Optional(Type.String()),
  password: Type.Optional(Type.String()),

  /* From ethers:
    * The priority used for the provider. Lower-value priorities are favoured over higher-value priorities. If
    * multiple providers share the same priority, they are chosen at random.
    * 
    * Defaults to 1.
    */
  priority: Type.Optional(Type.Number()),

  /* From ethers:
    * The weight a response from this provider provides. This can be used if a given Provider is more trusted, for example.
    * 
    * Defaults to 1.
    */
  weight: Type.Optional(Type.Number()),

  /* From ethers:
    * The timeout (in ms) after which another Provider will be attempted. This does not affect the current Provider; 
    * if it returns a result it is counted as part of the quorum.
    * Lower values will result in more network traffic, but may reduce the response time of requests.
    */
  stallTimeout: Type.Optional(Type.Number()),
});

export type ProviderConfig = Static<typeof ProviderConfigSchema>;
export const validateProviderConfig = ajv.compile(ProviderConfigSchema);
