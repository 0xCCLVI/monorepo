import { Signer, providers, utils, Bytes, BigNumber } from "ethers";
import { getAddressFromPublicKey } from "@connext/nxtp-utils";

import { signing, getPublicKey } from "./api";

export const messagePrefix = "\x19Ethereum Signed Message:\n";

export function prepareEthereumSignedMessage(message: Bytes | string): Bytes {
  if (typeof message === "string") {
    message = utils.toUtf8Bytes(message);
  }
  return utils.concat([utils.toUtf8Bytes(messagePrefix), utils.toUtf8Bytes(String(message.length)), message]);
}

export class Web3Signer extends Signer {
  public address?: string;
  public provider?: providers.Provider;

  constructor(public readonly web3SignerUrl: string, provider?: providers.Provider) {
    super();
    this.web3SignerUrl = web3SignerUrl;
    this.provider = provider;
  }

  public connect(provider: providers.Provider): Web3Signer {
    this.provider = provider;
    return this;
  }

  public async getAddress(): Promise<string> {
    const publicKey = await getPublicKey(this.web3SignerUrl);
    const address = getAddressFromPublicKey(publicKey);
    this.address = address;
    return address;
  }

  public async signMessage(message: Bytes | string): Promise<string> {
    const identifier = await getPublicKey(this.web3SignerUrl);
    const data = prepareEthereumSignedMessage(message);
    const digestBytes = utils.hexZeroPad(data, data.length);

    const response = await signing(this.web3SignerUrl, identifier, digestBytes);

    return response;
  }

  public async signTransaction(transaction: providers.TransactionRequest): Promise<string> {
    const tx = await utils.resolveProperties(transaction);
    const baseTx: utils.UnsignedTransaction = {
      chainId: tx.chainId || undefined,
      data: tx.data || undefined,
      gasLimit: tx.gasLimit || undefined,
      gasPrice: tx.gasPrice || undefined,
      nonce: tx.nonce ? BigNumber.from(tx.nonce).toNumber() : undefined,
      to: tx.to || undefined,
      value: tx.value || undefined,
    };

    const identifier = await getPublicKey(this.web3SignerUrl);
    const digestBytes = utils.serializeTransaction(baseTx);

    const signature = await signing(this.web3SignerUrl, identifier, digestBytes);
    return utils.serializeTransaction(baseTx, signature);
  }
}
