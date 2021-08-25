import { BigNumber } from "ethers";
import { restore, reset, createStubInstance, SinonStubbedInstance } from "sinon";
import pino from "pino";
import { err, ok } from "neverthrow";

import { TransactionDispatch } from "../../src/dispatch";
import { Transaction } from "../../src/dispatch/transaction";
import { DEFAULT_CONFIG } from "../../src/config";
import { TEST_TX, TEST_TX_RESPONSE, TEST_TX_RECEIPT, DEFAULT_GAS_LIMIT } from "../constants";
import {
  AlreadyMined,
  TimeoutError,
  TransactionReplaced,
  TransactionReverted,
  TransactionServiceFailure,
} from "../../src/error";
import { mkHash, expect } from "@connext/nxtp-utils";

const logger = pino({ level: process.env.LOG_LEVEL ?? "silent", name: "TransactionServiceTest" });

let transaction: Transaction;
let dispatch: SinonStubbedInstance<TransactionDispatch>;

describe("Transaction", () => {
  beforeEach(async () => {
    dispatch = createStubInstance(TransactionDispatch);
    (dispatch as any).confirmationTimeout = 60_000;
    (dispatch as any).confirmationsRequired = 1;
    TEST_TX_RECEIPT.confirmations = 1;
    dispatch.estimateGas.resolves(ok(DEFAULT_GAS_LIMIT));
    dispatch.getGasPrice.resolves(ok(TEST_TX_RESPONSE.gasPrice));
    dispatch.sendTransaction.resolves(ok(TEST_TX_RESPONSE));
    dispatch.confirmTransaction.resolves(ok(TEST_TX_RECEIPT));
    (dispatch as any).config = DEFAULT_CONFIG;

    transaction = await Transaction.create(logger, dispatch as unknown as TransactionDispatch, TEST_TX, {
      ...DEFAULT_CONFIG,
      maxNonceErrorCount: 10,
    });
  });

  afterEach(() => {
    restore();
    reset();
  });

  describe("didSubmit", () => {
    it("should return true if transaction was submitted", async () => {
      await transaction.submit();
      expect(transaction.didSubmit).to.be.true;
    });

    it("should return false if transaction was not submitted", async () => {
      expect(transaction.didSubmit).to.be.false;
    });
  });

  describe("didFinish", () => {
    it("should return true if transaction was finished", async () => {
      await transaction.submit();
      await transaction.confirm();
      expect(transaction.didFinish).to.be.true;
    });

    it("should return false if transaction has no receipt", async () => {
      await transaction.submit();
      expect(transaction.didFinish).to.be.false;
    });

    it("should return false if transaction has receipt but not enough confirmations", async () => {
      const timeoutError = new TimeoutError();
      dispatch.confirmTransaction.rejects(timeoutError);
      await transaction.submit();
      await expect(transaction.confirm()).to.be.rejectedWith(timeoutError);
      expect(transaction.didFinish()).to.be.false;
    });
  });

  describe("#submit", () => {
    it("happy: submit returns correct response", async () => {
      const response = await transaction.submit();
      // Expect response to be correct.

      expect(response).to.deep.eq(TEST_TX_RESPONSE);
      // Ensure that we called the nested chain provider method.
      expect(dispatch.sendTransaction.callCount).eq(1);
      const sendTransactionCall = dispatch.sendTransaction.getCall(0);
      const targetTx = sendTransactionCall.args[0];

      expect({
        ...targetTx,
        gasPrice: targetTx.params.gasPrice.toString(),
        gasLimit: targetTx.params.gasLimit.toString(),
      }).to.deep.eq({
        ...TEST_TX,
        gasPrice: TEST_TX_RESPONSE.gasPrice.toString(),
        nonce: undefined,
        gasLimit: DEFAULT_GAS_LIMIT.toString(),
      });
    });

    it("won't replace transaction without a higher gas price", async () => {
      // First call should go through fine.
      const response = await transaction.submit();
      expect(response).to.deep.eq(TEST_TX_RESPONSE);

      // Now we send off another tx to replace the last one. It should reject before sending.
      await expect(transaction.submit()).to.be.rejectedWith(TransactionServiceFailure);
    });

    it("handles nonce expired cases by retrying", async () => {
      // Computed test attempts to make sure this test stays working.
      const testAttempts = Math.floor((transaction as any).config.maxNonceErrorCount / 2);
      const nonceExpiredError = new AlreadyMined(AlreadyMined.reasons.NonceExpired);
      dispatch.sendTransaction.resolves(err(nonceExpiredError));
      dispatch.sendTransaction.onCall(testAttempts - 1).resolves(ok(TEST_TX_RESPONSE));
      await transaction.submit();
      expect(dispatch.sendTransaction.callCount).eq(testAttempts);
    });

    it("won't handle nonce expired case if we've already submitted once before", async () => {
      const nonceExpiredError = new AlreadyMined(AlreadyMined.reasons.NonceExpired);
      await transaction.submit();
      dispatch.sendTransaction.resolves(err(nonceExpiredError));

      // Simulate confirmation, for test reliability.
      dispatch.confirmTransaction.resolves(err(new TimeoutError()));
      await expect(transaction.confirm()).to.be.rejectedWith(TimeoutError);
      transaction.bumpGasPrice();

      // Now we should get the nonce expired error.
      await expect(transaction.submit()).to.be.rejectedWith(nonceExpiredError);
    });
  });

  describe("#validate", async () => {
    it("happy: should return true if transaction is valid", async () => {
      const response = await transaction.validate();
      expect(response).to.be.true;
    });

    it("happy: should return false if transaction is invalid", async () => {
      const response = await transaction.validate();
      expect(response).to.be.false;
    });
  });

  describe("#confirm", async () => {
    it("happy: confirmation on first loop", async () => {
      await transaction.submit();
      const receipt = await transaction.confirm();
      // Expect receipt to be correct.
      expect(receipt).to.deep.eq(TEST_TX_RECEIPT);
      // Ensure confirmTransaction was called.
      expect(dispatch.confirmTransaction.callCount).eq(1);
      const confirmTransaction = dispatch.confirmTransaction.getCall(0);
      // Ensure we pass the correct response.
      expect(confirmTransaction.args[0]).to.deep.eq(TEST_TX_RESPONSE);
    });

    it("throws if you have not submitted yet", async () => {
      await expect(transaction.confirm()).to.be.rejectedWith(TransactionServiceFailure);
    });

    it("escalates error if confirmation times out", async () => {
      const timeoutError = new TimeoutError();
      dispatch.confirmTransaction.resolves(err(timeoutError));
      await transaction.submit();
      await expect(transaction.confirm()).to.be.rejectedWith(timeoutError);
    });

    it("won't return until it has the required number of confirmations", async () => {
      // Raise confirmations required count for this test to 10.
      const testConfirmationsRequired = 10;
      (dispatch as any).confirmationsRequired = testConfirmationsRequired;

      // We should call confirm transaction twice, once for the first confirmation, and
      // again to get the required number of confirmations.
      dispatch.confirmTransaction.onCall(0).resolves(
        ok({
          ...TEST_TX_RECEIPT,
          confirmations: 1,
        }),
      );
      dispatch.confirmTransaction.onCall(1).resolves(
        ok({
          ...TEST_TX_RECEIPT,
          confirmations: testConfirmationsRequired,
        }),
      );

      await transaction.submit();
      const receipt = await transaction.confirm();
      expect(receipt.confirmations).to.eq(testConfirmationsRequired);
      expect(dispatch.confirmTransaction.callCount).eq(2);
    });

    it("handles case where transaction is replaced", async () => {
      // This test functioning is dependent on the confirmations required being set to 1!
      // Just to be sure this test stays working, we set it to 1 again here.
      (dispatch as any).confirmationsRequired = 1;
      TEST_TX_RECEIPT.confirmations = 1;

      const sendCount = 10;
      const minedTxIndex = 7;
      const txs = new Array(sendCount).fill(0).map((_, i) => {
        const tx = {
          ...TEST_TX_RESPONSE,
          hash: mkHash(),
        };
        dispatch.sendTransaction.onCall(i).resolves(ok(tx));
        dispatch.confirmTransaction.onCall(i).resolves(err(new TimeoutError()));
        return tx;
      });

      // The last confirm attempt in the stack should give us the replacement error, including the receipt for the mined tx.
      dispatch.confirmTransaction.onCall(sendCount - 1).resolves(
        err(
          new TransactionReplaced(
            {
              ...TEST_TX_RECEIPT,
              transactionHash: txs[minedTxIndex].hash,
            },
            txs[minedTxIndex],
          ),
        ),
      );

      // Simulate sending (and attempting to confirm) many transactions.
      for (let i = 0; i < sendCount - 1; i++) {
        await transaction.submit();
        await expect(transaction.confirm()).to.be.rejectedWith(TimeoutError);
        transaction.bumpGasPrice();
      }

      // The last transaction should be confirmed with the replacement receipt.
      const receipt = await transaction.confirm();
      // Just the compare the hashes, make sure the receipt is the correct one.
      expect(receipt.transactionHash).to.deep.eq(txs[minedTxIndex].hash);
    });

    it("if receipt status == 0, errors out immediately with appropriate error", async () => {
      dispatch.confirmTransaction.resolves(
        err(
          new TransactionReverted(TransactionReverted.reasons.CallException, {
            ...TEST_TX_RECEIPT,
            status: 0,
          }),
        ),
      );
      await transaction.submit();
      await expect(transaction.confirm()).to.be.rejectedWith(TransactionReverted);
      // Make sure we save the above receipt.
      expect(transaction.receipt).to.not.be.undefined;
      expect(transaction.receipt.status).to.eq(0);
    });

    it("will confirm the appropriate transaction when multiple have been submitted", async () => {});
  });

  describe("#bumpGasPrice", async () => {
    it("happy: bumps by configured percentage", async () => {
      const originalGasPrice = (transaction as any).gasPrice.get();
      transaction.bumpGasPrice();
      expect((transaction as any).gasPrice.get().gt(originalGasPrice)).to.be.true;
    });

    it("throws if it would bump above max gas price", async () => {
      // Make it so the gas price will return exactly == the maximum (which is acceptable).
      (transaction as any).gasPrice._gasPrice = BigNumber.from(DEFAULT_CONFIG.gasMaximum);

      // First call should go through fine.
      const response = await transaction.submit();
      expect(response).to.deep.eq(TEST_TX_RESPONSE);

      // This should throw, as we are attempting to bump above the maximum.
      expect(() => transaction.bumpGasPrice()).to.throw(TransactionServiceFailure.reasons.MaxGasPriceReached);
    });
  });
});
