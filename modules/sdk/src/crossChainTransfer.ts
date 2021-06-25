import { providers, BigNumber, constants } from "ethers";
import { signFulfillTransactionPayload, InvariantTransactionData } from "@connext/nxtp-utils";
import Ajv from "ajv";
import {
  TransactionManagerEvents,
  validateAndParseAddress,
  TransactionManagerListener,
  getTransactionManagerContract,
  getRandomBytes32,
} from "./utils";
import { PrepareParamType, ListenRouterPrepareParamType, ListenRouterFulfillParamType } from "./types";

export const ajv = new Ajv();

const switchChainIfNeeded = async (expectedChain: number, web3Provider: providers.Web3Provider) => {
  // Make sure user is on the receiving chain
  try {
    const { chainId } = await web3Provider.getNetwork();
    console.log(chainId, expectedChain);

    // TODO: what if they arent using metamask
    if (chainId !== expectedChain) {
      throw new Error(`user is on ${chainId} and should be on ${expectedChain}`);
      // const promise = new Promise<void>(resolve => {
      //   web3Provider.on("chainChanged", chainId => {
      //     if (chainId === receivingChainId) {
      //       resolve();
      //     }
      //   });
      // });

      // const networkSwitch = new Promise<void>((resolve, reject) => {
      //   web3Provider
      //     .send("wallet_switchEthereumChain", [{ chainId: BigNumber.from(receivingChainId).toHexString() }])
      //     .then(resolve)
      //     .catch(reject);
      // });

      // await Promise.all([promise, networkSwitch]);
    }
  } catch (e) {
    console.log(e);
    throw e;
  }
};

export const prepare = async (params: PrepareParamType): Promise<void> => {
  const method = "prepare";
  const methodId = getRandomBytes32();
  console.log(method, methodId);
  // const validate = ajv.compile(PrepareParamSchema);
  // const valid = validate(params);
  // if (!valid) {
  //   console.log(method, methodId, params);
  //   throw new Error("Invalid Params");
  // }

  try {
    const signer = params.userWebProvider.getSigner();
    const user = await signer.getAddress();

    // await switchChainIfNeeded(params.sendingChainId, params.userWebProvider);

    const { instance } = getTransactionManagerContract(params.sendingChainId, params.userWebProvider);

    const router = validateAndParseAddress(params.router);
    const sendingAssetId = validateAndParseAddress(params.sendingAssetId);
    const receivingAssetId = validateAndParseAddress(params.receivingAssetId);
    const receivingAddress = validateAndParseAddress(params.receivingAddress);

    const transactionId = getRandomBytes32();

    // validate expiry
    const expiry = params.expiry;

    const transaction: InvariantTransactionData = {
      user,
      router,
      sendingAssetId,
      receivingAssetId,
      receivingAddress,
      callData: params.callData ?? "0x",
      transactionId,
      sendingChainId: params.sendingChainId,
      receivingChainId: params.receivingChainId,
    };

    const record = {
      amount: params.amount,
      expiry,
    };

    const prepareTx = await instance
      .connect(signer)
      .prepare(
        transaction,
        record.amount,
        record.expiry,
        transaction.sendingAssetId === constants.AddressZero ? { value: record.amount } : {},
      );

    const prepareReceipt = await prepareTx.wait(1);
    console.log(prepareReceipt);
    if (prepareReceipt.status === 0) {
      throw new Error("Transaction reverted onchain");
    }
  } catch (e) {
    console.log(e);
    throw e;
  }
};

export type TransactionPrepareEvent = {
  txData: InvariantTransactionData;
  amount: BigNumber;
  expiry: BigNumber;
  blockNumber: BigNumber;
  caller: string;
};

export const listenRouterPrepare = async (
  params: ListenRouterPrepareParamType,
  listener: TransactionManagerListener,
): Promise<void> => {
  const method = "listenRouterPrepare";
  const methodId = getRandomBytes32();
  console.log(method, methodId, params.txData, params.relayerFee);

  // Make sure user is on the receiving chain
  await switchChainIfNeeded(params.txData.receivingChainId, params.userWebProvider);

  const signer = params.userWebProvider.getSigner();

  // Wait 1min for router event
  const event = await listener.waitFor(
    TransactionManagerEvents.TransactionPrepared,
    60_000,
    (data) => data.txData.transactionId === params.txData.transactionId,
  );

  // Generate signature
  const signature = await signFulfillTransactionPayload(event.txData, params.relayerFee.toString(), signer);

  // TODO: broadcast from messaging service here and add logic to wait
  // for relayer submission or submit it on our own before expiry
  // Submit fulfill to receiver chain
  const instance = listener.getTransactionManager().connect(signer);
  const fulfillTx = await instance.fulfill(event.txData, params.relayerFee.toString(), signature);
  await fulfillTx.wait();
};

// NOTE: once we have submitted the `Fulfill` we dont need to wait for the
// router to do it
export const listenRouterFulfill = async (
  params: ListenRouterFulfillParamType,
  listener: TransactionManagerListener,
): Promise<void> => {
  const method = "listenRouterFulfill";
  const methodId = getRandomBytes32();
  console.log(method, methodId, params);

  // Make sure user is on the receiving chain
  await switchChainIfNeeded(params.txData.receivingChainId, params.userWebProvider);

  await listener.waitFor(TransactionManagerEvents.TransactionFulfilled, 60_000, (data) => {
    return data.txData.transactionId === params.txData.transactionId && data.caller === params.txData.router;
  });
};
