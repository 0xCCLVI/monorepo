import { providers, Signer, BigNumber } from "ethers";
import { AddressZero, One, Zero } from "@ethersproject/constants";
import { mkHash, mkAddress } from "@connext/nxtp-utils";
import { restore, reset, createStubInstance, SinonStubbedInstance, stub, SinonStub } from "sinon";
import pino from "pino";

import TransactionService from "../txservice";

const { JsonRpcProvider } = providers;
type TransactionReceipt = providers.TransactionReceipt;
type TransactionResponse = providers.TransactionResponse;

let signer: SinonStubbedInstance<Signer>;
let txService: TransactionService;
let provider1337: SinonStubbedInstance<providers.JsonRpcProvider>;
let provider1338: SinonStubbedInstance<providers.JsonRpcProvider>;

let confirmTxMock: SinonStub;

const txResponse: TransactionResponse = {
  chainId: 1337,
  confirmations: 1,
  data: "0x",
  from: AddressZero,
  gasLimit: One,
  gasPrice: One,
  hash: mkHash(),
  nonce: 1,
  value: Zero,
  wait: () => Promise.resolve({} as TransactionReceipt),
};

const txReceipt: TransactionReceipt = {
  blockHash: mkHash("0xabc"),
  blockNumber: 123,
  byzantium: true,
  confirmations: 1,
  contractAddress: mkAddress("0xa"),
  cumulativeGasUsed: BigNumber.from(21000),
  from: txResponse.from,
  gasUsed: BigNumber.from(21000),
  logs: [],
  logsBloom: "0x",
  to: mkAddress("0xbbb"),
  transactionHash: txResponse.hash,
  transactionIndex: 1,
  status: 1,
};

const log = pino({ level: "debug", name: "TransactionServiceTest" });
describe("TransactionService unit test", () => {
  beforeEach(() => {
    signer = createStubInstance(Signer);
    signer.connect.returns(signer as any);
    (signer as any)._isSigner = true;

    const _provider = createStubInstance(JsonRpcProvider);
    _provider.getTransaction.resolves(txResponse);
    provider1337 = _provider;
    provider1338 = _provider;
    (signer as any).provider = provider1337;

    txService = new TransactionService(
      log,
      signer
    );
  });

  afterEach(() => {
    restore();
    reset();
  });
});
