import { Signer, Wallet } from "ethers";
import { arrayify, solidityKeccak256, verifyMessage } from "ethers/lib/utils";

import { InvariantTransactionData, TransactionData } from "./transactionManager";
import { encodeCancelData, encodeFulfillData } from "./encode";

export const signFulfillTransactionPayload = (
  data: TransactionData,
  relayerFee: string,
  signer: Wallet | Signer,
): Promise<string> => {
  const payload = encodeFulfillData(data, relayerFee);
  const hash = solidityKeccak256(["bytes"], [payload]);

  return signer.signMessage(arrayify(hash));
};

export const recoverFulfilledTransactionPayload = (
  data: TransactionData,
  relayerFee: string,
  signature: string,
): string => {
  const payload = encodeFulfillData(data, relayerFee);
  const hashed = solidityKeccak256(["bytes"], [payload]);
  return verifyMessage(arrayify(hashed), signature);
};

export const signCancelTransactionPayload = async (
  txDataParams: InvariantTransactionData,
  relayerFee: string,
  signer: Signer,
): Promise<string> => {
  const payload = encodeCancelData(txDataParams, relayerFee);
  const hashed = solidityKeccak256(["bytes"], [payload]);
  return signer.signMessage(arrayify(hashed));
};

export const recoverCancelTransactionPayload = (
  txDataParams: InvariantTransactionData,
  relayerFee: string,
  signature: string,
): string => {
  const payload = encodeCancelData(txDataParams, relayerFee);
  const hashed = solidityKeccak256(["bytes"], [payload]);
  return verifyMessage(arrayify(hashed), signature);
};
