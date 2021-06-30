import { TransactionManager as TTransactionManager } from "@connext/nxtp-contracts";
import { TransactionService } from "@connext/nxtp-txservice";
import TransactionManagerArtifact from "@connext/nxtp-contracts/artifacts/contracts/TransactionManager.sol/TransactionManager.json";
import { Interface } from "ethers/lib/utils";
import { BigNumber, constants, providers } from "ethers";
import { InvariantTransactionData, calculateExchangeAmount, jsonifyError } from "@connext/nxtp-utils";
import { v4 } from "uuid";
import { BaseLogger } from "pino";

<<<<<<< HEAD

import {getConfig, NxtpRouterConfig} from "./config";
import {SenderFulfillData} from "./transactionManagerListener";
=======
import { getConfig, NxtpRouterConfig } from "./config";
import { ReceiverFulfillData, SenderFulfillData, SenderPrepareData } from "./transactionManagerListener";
>>>>>>> 38fdeae6c9f4d64248791a47f52a71166f58fc47

export class TransactionManager {
  private readonly txManagerInterface: TTransactionManager["interface"];
  private readonly config: NxtpRouterConfig;
  private readonly EXPIRY_DECREMENT = 3600 * 24;
  private readonly SWAP_RATE = "0.995";

  constructor(
    private readonly txService: TransactionService,
    private readonly signerAddress: string,
    private readonly logger: BaseLogger,
  ) {
    this.txManagerInterface = new Interface(TransactionManagerArtifact.abi) as TTransactionManager["interface"];
    this.config = getConfig();

    // TODO: remove when using for real, this is just to avoid breaking build
    console.log("this.txManagerInterface", !!this.txManagerInterface);
    console.log("this.txService", !!this.txService);
    console.log("this.signerAddress", !!this.signerAddress);
  }

  async prepare(txData: SenderPrepareData): Promise<providers.TransactionReceipt> {
    const method = "Contract::prepare ";
    const methodId = v4();

    const mutateAmount = (amount: string) => {
      return calculateExchangeAmount(amount, this.SWAP_RATE);
    };
    const mutateExpiry = (expiry: number) => {
      const rxExpiry = expiry - this.EXPIRY_DECREMENT;
      if (rxExpiry < Date.now() / 1000) {
        throw new Error("Expiration already happened, cant prepare");
      }
      return rxExpiry;
    };

    const txParams = {
      callData: txData.callData,
      receivingAddress: txData.receivingAddress,
      receivingAssetId: txData.receivingAssetId,
      receivingChainId: txData.receivingChainId,
      router: txData.router,
      sendingAssetId: txData.sendingAssetId,
      sendingChainId: txData.sendingChainId,
      transactionId: txData.transactionId,
      user: txData.user,
    };

    // @ts-ignore
    const encodedData = this.txManagerInterface.encodeFunctionData("prepare", [
      txParams,
      mutateAmount(txData.amount),
      mutateExpiry(txData.expiry),
      "0x", // TODO: encoded bid
      "0x", // TODO: bid signature
    ]);

    try {
      const txRes = await this.txService.sendAndConfirmTx(txParams.receivingChainId, {
        to: this.config.chainConfig[txParams.receivingChainId].transactionManagerAddress,
        data: encodedData,
        value: constants.Zero,
        chainId: txParams.receivingChainId,
        from: this.signerAddress,
      });
      return txRes;
    } catch (e) {
      if (e.message.includes("DUPLICATE_DIGEST")) {
        this.logger.warn(
          { methodId, method, transactionId: txParams.transactionId },
          "Receiver tx already prepared, but resubmitted",
        );
      }
      this.logger.error(
        { methodId, method, error: jsonifyError(e), transactionId: txParams.transactionId },
        // "Error sending receiver prepare tx",
      );
      // TODO: cancel sender here?
      throw e;
    }
  }

  async fulfill(
    receiverTxData: ReceiverFulfillData,
    senderTxData: SenderFulfillData,
  ): Promise<providers.TransactionReceipt> {
    const method = "Contract::fulfill";
    const methodId = v4();
    this.logger.info({ method, methodId, receiverTxData }, "Method start");

    const txParams: Partial<SenderFulfillData> = {
      callData: receiverTxData.callData,
      receivingAddress: receiverTxData.receivingAddress,
      receivingAssetId: receiverTxData.receivingAssetId,
      receivingChainId: receiverTxData.receivingChainId,
      router: receiverTxData.router,
      sendingAssetId: receiverTxData.sendingAssetId,
      sendingChainId: receiverTxData.sendingChainId,
      transactionId: receiverTxData.transactionId,
      user: receiverTxData.user,
      amount: senderTxData.amount,
      expiry: senderTxData.expiry,
      blockNumber: senderTxData.blockNumber,
    };
    const relayerFee = BigNumber.from(receiverTxData.relayerFee);
    //will sig always be included (even on sender side)?
    const sig = receiverTxData.signature;
    // @ts-ignore
    const fulfilData = this.txManagerInterface.encodeFunctionData("fulfill", [txParams, relayerFee, sig]);
    try {
      const txRes = await this.txService.sendAndConfirmTx(receiverTxData.sendingChainId, {
        chainId: receiverTxData.sendingChainId,
        data: fulfilData,
        to: this.config.chainConfig[receiverTxData.sendingChainId].transactionManagerAddress,
        value: 0,
        from: this.signerAddress,
      });
      return txRes;
    } catch (e) {
      // If fail -- something has gone really wrong here!! We need to figure out what ASAP.
      this.logger.error(
        { methodId, method, transactionId: receiverTxData.transactionId, error: jsonifyError(e) },
        "Error sending sender fulfill tx",
      );
      // TODO discuss this case!!
      throw e;
    }
  }

  async cancel(chainId:number, txData:InvariantTransactionData, signature:string): Promise<providers.TransactionReceipt> {
    const method = "Contract::cancel";
    const methodId = v4();
    this.logger.info({ method, methodId, txData }, "Method start");
    // encode and call tx service
    const txParams = {
      user: txData.user,
      router: txData.router,
      sendingAssetId: txData.sendingAssetId,
      receivingAssetId: txData.receivingAssetId,
      receivingAddress: txData.receivingAddress,
      sendingChainId: txData.sendingChainId,
      receivingChainId: txData.receivingChainId,
      callData: txData.callData,
      transactionId: txData.transactionId,
    };

    //@ts-ignore
    const cancelData = this.txManagerInterface.encodeFunctionData("cancel", [txParams, signature]);

    try {
      const txRes = await this.txService.sendAndConfirmTx(chainId, {
        chainId: chainId,
        data: cancelData,
        to: this.config.chainConfig[chainId].transactionManagerAddress,
        value: 0,
        from: this.signerAddress,
      });
      return txRes;
    } catch (e) {
      throw new Error(`cancel error ${JSON.stringify(e)}`);
    }
  }

  getLiquidity(chainId: number, assetId:string): Promise<string>{
    const getLiquidityData = this.txManagerInterface.encodeFunctionData("routerBalances",[this.signerAddress, assetId]);
    const liquidity = this.txService.readTx(chainId, {
      chainId: chainId,
      to: this.config.chainConfig[chainId].transactionManagerAddress,
      value: 0,
      data: getLiquidityData,
    });
    return liquidity;
  }

  async addLiquidity(
    chainId: number,
    amount: string,
    assetId: string = constants.AddressZero,
  ): Promise<providers.TransactionReceipt> {
    const nxtpContractAddress = getConfig().chainConfig[chainId].transactionManagerAddress;
    const bnAmount = BigNumber.from(amount);

    const addLiquidityData = this.txManagerInterface.encodeFunctionData("addLiquidity", [bnAmount, assetId]);
    try {
      const txRes = await this.txService.sendAndConfirmTx(chainId, {
        chainId: chainId,
        data: addLiquidityData,
        to: nxtpContractAddress,
        value: 0,
      });
      return txRes;
    } catch (e) {
      throw new Error(`Add liquidity error ${JSON.stringify(e)}`);
    }
  }

  async removeLiquidity(
    chainId: number,
    amount: string,
    assetId: string = constants.AddressZero,
    recipientAddress: string | undefined,
  ): Promise<providers.TransactionReceipt> {
    //should we remove liquidity for self if there isn't another address specified?
    if (!recipientAddress)
      //@ts-ignore
      recipientAddress = await this.txService.chains.get(chainId).getAddress();

    const nxtpContractAddress = getConfig().chainConfig[chainId].transactionManagerAddress;
    const bnAmount = BigNumber.from(amount).toString();

    //@ts-ignore
    const removeLiquidityData = this.txManagerInterface.encodeFunctionData("removeLiquidity", [
      bnAmount,
      assetId,
      recipientAddress,
    ]);

    try {
      const txRes = await this.txService.sendAndConfirmTx(chainId, {
        chainId: chainId,
        data: removeLiquidityData,
        to: nxtpContractAddress,
        value: 0,
      });
      return txRes;
    } catch (e) {
      throw new Error(`remove liquidity error ${JSON.stringify(e)}`);
    }
  }
}
