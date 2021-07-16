import { ethers, waffle } from "hardhat";
import { expect } from "chai";
import { getRandomBytes32 } from "@connext/nxtp-utils";
import { mkAddress, PrepareParams } from "@connext/nxtp-utils";
import { Wallet, BigNumberish, Contract, utils, BigNumber, constants } from "ethers";

import { FulfillInterpreter, Counter, TransactionManager, TestERC20 } from "@connext/nxtp-contracts/typechain";
import TransactionManagerArtifact from "@connext/nxtp-contracts/artifacts/contracts/TransactionManager.sol/TransactionManager.json";
import FulfillInterpreterArtifact from "@connext/nxtp-contracts/artifacts/contracts/interpreters/FulfillInterpreter.sol/FulfillInterpreter.json";
import CounterArtifact from "@connext/nxtp-contracts/artifacts/contracts/test/Counter.sol/Counter.json";
import TestERC20Artifact from "@connext/nxtp-contracts/artifacts/contracts/test/TestERC20.sol/TestERC20.json";

import pino, { BaseLogger } from "pino";
import { prepare, createEvts } from "../src";

const { AddressZero } = constants;
const logger: BaseLogger = pino();

const createFixtureLoader = waffle.createFixtureLoader;
describe("TransactionManager", function () {
  const [wallet, router, user, receiver] = waffle.provider.getWallets();

  const sendingChainId = 1337;
  const receivingChainId = 1338;
  const routerFunds = "1000";
  const userFunds = "100";

  let transactionManager: TransactionManager;
  let transactionManagerReceiverSide: TransactionManager;
  let counter: Counter;
  let tokenA: TestERC20;
  let tokenB: TestERC20;

  const fixture = async () => {
    const transactionManagerFactory = await ethers.getContractFactory(
      TransactionManagerArtifact.abi,
      TransactionManagerArtifact.bytecode,
      wallet,
    );
    const counterFactory = await ethers.getContractFactory(CounterArtifact.abi, CounterArtifact.bytecode, wallet);
    const testERC20Factory = await ethers.getContractFactory(TestERC20Artifact.abi, TestERC20Artifact.bytecode, wallet);
    const interpreterFactory = await ethers.getContractFactory(
      FulfillInterpreterArtifact.abi,
      FulfillInterpreterArtifact.bytecode,
      wallet,
    );

    const interpreter = (await interpreterFactory.deploy()) as FulfillInterpreter;

    transactionManager = (await transactionManagerFactory.deploy(
      sendingChainId,
      interpreter.address,
    )) as TransactionManager;
    transactionManagerReceiverSide = (await transactionManagerFactory.deploy(
      receivingChainId,
      interpreter.address,
    )) as TransactionManager;

    tokenA = (await testERC20Factory.deploy()) as TestERC20;
    tokenB = (await testERC20Factory.deploy()) as TestERC20;

    counter = (await counterFactory.deploy()) as Counter;

    return { transactionManager, transactionManagerReceiverSide, tokenA, tokenB };
  };

  let loadFixture: ReturnType<typeof createFixtureLoader>;

  const addPrivileges = async (tm: TransactionManager, routers: string[], assets: string[]) => {
    for (const router of routers) {
      const tx = await tm.addRouter(router);
      await tx.wait();
      expect(await tm.approvedRouters(router)).to.be.true;
    }

    for (const assetId of assets) {
      const tx = await tm.addAssetId(assetId);
      await tx.wait();
      expect(await tm.approvedAssets(assetId)).to.be.true;
    }
  };

  before("create fixture loader", async () => {
    loadFixture = createFixtureLoader([wallet, user, receiver]);
  });

  beforeEach(async function () {
    ({ transactionManager, transactionManagerReceiverSide, tokenA, tokenB } = await loadFixture(fixture));
    await addPrivileges(transactionManager, [router.address], [AddressZero, tokenA.address, tokenB.address]);

    await tokenB.connect(wallet).transfer(router.address, routerFunds);

    await tokenA.connect(wallet).transfer(user.address, userFunds);
  });

  it("should deploy", async () => {
    expect(transactionManager.address).to.be.a("string");
    expect(tokenA.address).to.be.a("string");
    expect(tokenB.address).to.be.a("string");
  });

  const approveTokens = async (amount: BigNumberish, approver: Wallet, token: Contract) => {
    const approveTx = await token.connect(approver).approve(transactionManager.address, amount);
    await approveTx.wait();
  };

  it("happy test: prepare", async () => {
    const callData = "0x";
    const callDataHash = utils.keccak256(callData);
    const evts = createEvts();
    const day = 24 * 60 * 60;

    const params: PrepareParams = {
      bidSignature: "0x",
      encodedBid: "0x",
      expiry: (Math.floor(Date.now() / 1000) + day + 5_000).toString(),
      amount: BigNumber.from(1).toString(),
      encryptedCallData: "0x",
      txData: {
        user: user.address,
        router: router.address,
        sendingAssetId: tokenA.address,
        receivingAssetId: tokenB.address,
        receivingAddress: receiver.address,
        callTo: mkAddress("0xf"),
        sendingChainFallback: user.address,
        transactionId: getRandomBytes32(),
        callDataHash: callDataHash,
        sendingChainId: (await transactionManager.chainId()).toNumber(),
        receivingChainId: (await transactionManagerReceiverSide.chainId()).toNumber(),
      },
    };
    await approveTokens(params.amount, user, tokenA);

    const res = await prepare(params, transactionManager, user, evts, logger, tokenA);
    expect(res.status).to.be.eq(1);
  });
});
