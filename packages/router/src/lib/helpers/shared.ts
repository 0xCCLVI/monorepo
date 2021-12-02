import {
  getNtpTimeSeconds as _getNtpTimeSeconds,
  RequestContext,
  multicall as _multicall,
  Call,
} from "@connext/nxtp-utils";
import { getAddress } from "ethers/lib/utils";
import { BigNumber, utils } from "ethers";

import { getContext } from "../../router";

/**
 * Helper to allow easy mocking
 */
export const getNtpTimeSeconds = async () => {
  return await _getNtpTimeSeconds();
};

/**
 * Returns the mainnet equivalent of the given asset on the given chain from chain data.
 * @param assetId Address you want mainnet equivalent of
 * @param chainId Chain your asset lives on
 * @returns Address of equivalent asset on mainnet
 */
export const getMainnetEquivalentFromChainData = async (assetId: string, chainId: number): Promise<string | null> => {
  const { chainData } = getContext();
  if (!chainData || !chainData.has(chainId.toString())) {
    return null;
  }
  const chain = chainData.get(chainId.toString())!;
  const equiv =
    chain.assetId[utils.getAddress(assetId)] ??
    chain.assetId[assetId.toLowerCase()] ??
    chain.assetId[assetId.toUpperCase()] ??
    chain.assetId[assetId];

  if (!equiv || !equiv.mainnetEquivalent) {
    return null;
  }
  return utils.getAddress(equiv.mainnetEquivalent);
};

/**
 * Returns the mainnet equivalent of the given asset on the given chain
 * Reads from config first, if it fails, tries to read from chain data.
 *
 * @param assetId Address you want mainnet equivalent of
 * @param chainId Chain your asset lives on
 * @returns Address of equivalent asset on mainnet
 */
export const getMainnetEquivalent = async (assetId: string, chainId: number): Promise<string | null> => {
  const { config } = getContext();
  const allowedSwapPool = config.swapPools.find((pool) =>
    pool.assets.find((a) => getAddress(a.assetId) === getAddress(assetId) && a.chainId === chainId),
  );
  if (allowedSwapPool && allowedSwapPool.mainnetEquivalent) {
    return allowedSwapPool.mainnetEquivalent;
  } else {
    return await getMainnetEquivalentFromChainData(assetId, chainId);
  }
};

/**
 * Helper to calculate router gas fee in token
 *
 * @param sendingAssetId The asset address on source chain
 * @param sendingChainId The source chain Id
 * @param receivingAssetId The asset address on destination chain
 * @param receivingChainId The destination chain Id
 * @param _outputDecimals Decimal number of receiving asset
 * @param requestContext Request context instance
 */
export const calculateGasFeeInReceivingToken = async (
  sendingAssetId: string,
  sendingChainId: number,
  receivingAssetId: string,
  receivingChainId: number,
  outputDecimals: number,
  requestContext: RequestContext,
): Promise<BigNumber> => {
  const { txService } = getContext();
  const sendingAssetIdOnMainnet = await getMainnetEquivalent(sendingAssetId, sendingChainId);
  const tokenPricingSendingChain = sendingAssetIdOnMainnet ? 1 : sendingChainId;
  const tokenPricingAssetIdSendingChain = sendingAssetIdOnMainnet ? sendingAssetIdOnMainnet : sendingAssetId;

  const receivingAssetIdOnMainnet = await getMainnetEquivalent(receivingAssetId, receivingChainId);
  const tokenPricingReceivingChain = receivingAssetIdOnMainnet ? 1 : receivingChainId;
  const tokenPricingAssetIdReceivingChain = receivingAssetIdOnMainnet ? receivingAssetIdOnMainnet : receivingAssetId;

  return txService.calculateGasFeeInReceivingToken(
    tokenPricingSendingChain,
    sendingChainId,
    tokenPricingAssetIdSendingChain,
    tokenPricingReceivingChain,
    receivingChainId,
    tokenPricingAssetIdReceivingChain,
    outputDecimals,
    requestContext,
  );
};

/**
 * Helper to calculate router gas fee in token for meta transaction
 *
 * @param receivingAssetId The asset address on destination chain
 * @param receivingChainId The destination chain Id
 * @param outputDecimals Decimal number of receiving asset
 * @param requestContext Request context instance
 */
export const calculateGasFeeInReceivingTokenForFulfill = async (
  receivingAssetId: string,
  receivingChainId: number,
  outputDecimals: number,
  requestContext: RequestContext,
): Promise<BigNumber> => {
  const { txService } = getContext();

  const receivingAssetIdOnMainnet = await getMainnetEquivalent(receivingAssetId, receivingChainId);
  const tokenPricingReceivingChain = receivingAssetIdOnMainnet ? 1 : receivingChainId;
  const tokenPricingAssetIdReceivingChain = receivingAssetIdOnMainnet ? receivingAssetIdOnMainnet : receivingAssetId;

  return txService.calculateGasFeeInReceivingTokenForFulfill(
    tokenPricingReceivingChain,
    receivingChainId,
    tokenPricingAssetIdReceivingChain,
    outputDecimals,
    requestContext,
  );
};

export const getTokenPriceFromOnChain = async (
  chainId: number,
  assetId: string,
  requestContext?: RequestContext,
): Promise<BigNumber> => {
  const { txService } = getContext();
  return txService.getTokenPriceFromOnChain(chainId, assetId, requestContext);
};

/**
 * Runs multiple calls at a time, call data should be read methods. used to make it easier for sinon mocks to happen in test cases.
 *
 * @param abi - The ABI data of target contract
 * @param calls - The call data what you want to read from contract
 * @param multicallAddress - The address of multicall contract deployed to configured chain
 * @param rpcUrl - The rpc endpoints what you want to call with
 *
 * @returns Array in ethers.BigNumber
 */
export const multicall = async (abi: any[], calls: Call[], multicallAddress: string, rpcUrl: string) => {
  return await _multicall(abi, calls, multicallAddress, rpcUrl);
};
