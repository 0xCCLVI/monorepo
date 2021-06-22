// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.1;

import "./interfaces/ITransactionManager.sol";
import "./lib/LibAsset.sol";
import "./lib/LibERC20.sol";
import "./lib/LibIterableMapping.sol";
import "@gnosis.pm/safe-contracts/contracts/libraries/MultiSendCallOnly.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract TransactionManager is ReentrancyGuard, ITransactionManager {

    using LibIterableMapping for LibIterableMapping.IterableMapping;

    // Mapping of router to balance specific to asset
    mapping(address => mapping(address => uint256)) public routerBalances;

    /// @notice  Contains all the variable parts of a transaction, and a block
    ///          number to look up the rest of the data via events. The 
    ///          variable parts of the transaction data cannot be signed in the 
    ///          digest, since then the digest and signature would be different 
    ///          for sending and receiving chains. Must be iterable so user can
    ///          always pull their pending transactions without knowing the 
    ///          digest.
    LibIterableMapping.IterableMapping activeTransactions;

    /// @dev The chain id of the contract, is passed in to avoid any evm issues
    uint24 public immutable chainId;

    /// @dev Address of the deployed multisending helper contract
    address public immutable multisend;

    // TODO: determine min timeout
    uint256 public constant MIN_TIMEOUT = 0;

    constructor(address _multisend, uint24 _chainId) {
        multisend = _multisend;
        chainId = _chainId;
    }

    /// @dev returns all active transactions for a given user
    function getActiveTransactionsByUser(address user) external view override returns (VariableTransactionData[] memory) {
      return activeTransactions.getTransactionsByUser(user);
    }

    /// @param amount The amount of liquidity to add for the router
    /// @param assetId The address (or `address(0)` if native asset) of the
    ///                asset you're adding liquidity for
    function addLiquidity(uint256 amount, address assetId)
        external  
        payable 
        override 
        nonReentrant
    {
        // Validate correct amounts are transferred
        if (LibAsset.isEther(assetId)) {
            require(msg.value == amount, "addLiquidity: VALUE_MISMATCH");
        } else {
            require(msg.value == 0, "addLiquidity: ETH_WITH_ERC_TRANSFER");
            require(
                LibERC20.transferFrom(
                    assetId,
                    msg.sender,
                    address(this),
                    amount
                ),
                "addLiquidity: ERC20_TRANSFER_FAILED"
            );
        }

        // Update the router balances
        routerBalances[msg.sender][assetId] += amount;

        // Emit event
        emit LiquidityAdded(msg.sender, assetId, amount);
    }

    function removeLiquidity(uint256 amount, address assetId, address payable recipient)
        external
        override
        nonReentrant
    {
        // Check that the amount can be deducted for the router
        require(routerBalances[msg.sender][assetId] >= amount, "removeLiquidity: INSUFFICIENT_FUNDS");

        // Update router balances
        routerBalances[msg.sender][assetId] -= amount;

        // Transfer from contract to router
        require(LibAsset.transferAsset(assetId, recipient, amount), "removeLiquidity: TRANSFER_FAILED");

        // Emit event
        emit LiquidityRemoved(msg.sender, assetId, amount, recipient);
    }

    function prepare(
        TransactionData calldata txData
    ) external payable override nonReentrant returns (TransactionData memory) {
        // Make sure the expiry is greater than min
        require((txData.expiry - block.timestamp) >= MIN_TIMEOUT, "prepare: TIMEOUT_TOO_LOW");

        // Make sure the chains are different
        require(txData.sendingChainId != txData.receivingChainId, "prepare: SAME_CHAINIDS");

        // Make sure the chains are relevant
        require(txData.sendingChainId == chainId || 
            txData.receivingChainId == chainId, "prepare: INVALID_CHAINIDS");

        // Sanity check: valid fallback
        require(txData.receivingAddress != address(0), "prepare: INVALID_RECEIVING_ADDRESS");
        
        // Make sure the hash is not a duplicate
        bytes32 digest = hashTransactionData(txData);
        require(!activeTransactions.digestExists(digest), "prepare: DUPLICATE_DIGEST");

        // First determine if this is sender side or receiver side
        if (txData.sendingChainId == chainId) {
            // This is sender side prepare

            // Validate correct amounts and transfer
            if (LibAsset.isEther(txData.sendingAssetId)) {
                require(msg.value == txData.amount, "prepare: VALUE_MISMATCH");
            } else {
                require(msg.value == 0, "prepare: ETH_WITH_ERC_TRANSFER");
                require(
                    LibERC20.transferFrom(
                        txData.sendingAssetId,
                        msg.sender,
                        address(this),
                        txData.amount
                    ),
                    "prepare: ERC20_TRANSFER_FAILED"
                );
            }
        } else {
            // This is receiver side prepare

            // Make sure this is the right chain
            require(chainId == txData.receivingChainId, "prepare: INVALID_RECEIVING_CHAIN");

            // Check that the caller is the router
            require(msg.sender == txData.router, "prepare: ROUTER_MISMATCH");

            // Check that router has liquidity
            require(routerBalances[txData.router][txData.receivingAssetId] >= txData.amount, "prepare: INSUFFICIENT_LIQUIDITY");

            // NOTE: Timeout and amounts should have been decremented offchain

            // NOTE: after some consideration, it feels like it's better to leave amount/fee
            // validation *outside* the contracts as we likely want the logic to be flexible

            // Pull funds from router balance (use msg.sender here to mitigate 3rd party attack)

            // What would happen if some router tried to swoop in and steal another router's spot?
            // - 3rd party router could EITHER use original txData or replace txData.router with itself
            // - if original txData, 3rd party router would basically be paying for original router
            // - if relaced router address, user sig on digest would not unlock sender side
            routerBalances[txData.router][txData.receivingAssetId] -= txData.amount;
        }

        // Store the transaction variants
        activeTransactions.addTransaction(
          VariableTransactionData({ amount: txData.amount, expiry: txData.expiry, digest: digest, user: txData.user, blockNumber: block.number })
        );

        // Emit event
        emit TransactionPrepared(txData, msg.sender);
        return txData;
    }

    function fulfill(
        TransactionData calldata txData,
        uint256 relayerFee,
        bytes calldata signature // signature on fee + digest
    ) external override nonReentrant returns (TransactionData memory) {
        // Make sure params match against stored data
        // Also checks that there is an active transfer here
        // Also checks that sender or receiver chainID is this chainId (bc we 
        // checked it previously)
        bytes32 digest = hashTransactionData(txData);

        // Retrieving this will revert if the record does not exist by the
        // digest (which asserts all but tx.amount, tx.expiry)
        VariableTransactionData memory record = activeTransactions.getTransactionByDigest(digest);

        // Amount and expiry should be the same as the record
        require(record.amount == txData.amount, "fulfill: INVALID_AMOUNT");

        require(record.expiry == txData.expiry, "fulfill: INVALID_EXPIRY");

        // Validate signature
        require(recoverFulfillSignature(txData, relayerFee, signature) == txData.user, "fulfill: INVALID_SIGNATURE");

        // Sanity check: fee < amount
        require(relayerFee < txData.amount, "fulfill: INVALID_RELAYER_FEE");
    
        if (txData.sendingChainId == chainId) {
            // Complete tx to router
            // NOTE: there is no fee taken on the sending side for the relayer
            routerBalances[txData.router][txData.sendingAssetId] += txData.amount;
        } else {
            // Complete tx to user
            // Get the amount to send
            uint256 toSend = txData.amount - relayerFee;

            if (keccak256(txData.callData) == keccak256(new bytes(0))) {
                // No external calls, send directly to receiving address
                require(LibAsset.transferAsset(txData.receivingAssetId, payable(txData.receivingAddress), toSend), "fulfill: TRANSFER_FAILED");
            } else {

                // Send the relayer the fee
                if (relayerFee > 0) {
                  require(LibAsset.transferAsset(txData.receivingAssetId, payable(msg.sender), relayerFee), "fulfill: FEE_TRANSFER_FAILED");
                }

                // Handle external calls with a fallback to the receiving
                // address
                try MultiSendCallOnly(multisend).multiSend(txData.callData) {
                } catch {
                  require(LibAsset.transferAsset(txData.receivingAssetId, payable(txData.receivingAddress), toSend), "fulfill: TRANSFER_FAILED");
                }
            }
        }

        // Send the relayer the fee
        if (relayerFee > 0) {
          require(LibAsset.transferAsset(txData.receivingAssetId, payable(msg.sender), relayerFee), "fulfill: FEE_TRANSFER_FAILED");
        }

        // Remove the active transaction
        activeTransactions.removeTransaction(digest);

        // Emit event
        emit TransactionFulfilled(txData, relayerFee, signature, msg.sender);

        return txData;
    }

    // Tx can be "collaboratively" cancelled by the receiver at any time and by the sender after expiry
    function cancel(
        TransactionData calldata txData,
        bytes calldata signature
    ) external override nonReentrant returns (TransactionData memory) {     
        // Make sure params match against stored data
        // Also checks that there is an active transfer here
        // Also checks that sender or receiver chainID is this chainId (bc we checked it previously)
        bytes32 digest = hashTransactionData(txData);
        
        // Retrieving this will revert if the record does not exist by the
        // digest (which asserts all but tx.amount, tx.expiry)
        VariableTransactionData memory record = activeTransactions.getTransactionByDigest(digest);

        // Amount and expiry should be the same as the record
        require(record.amount == txData.amount, "cancel: INVALID_AMOUNT");

        require(record.expiry == txData.expiry, "cancel: INVALID_EXPIRY");

        if (txData.sendingChainId == chainId) {
            // Sender side --> funds go back to user
            if (txData.expiry >= block.timestamp) {
                // Timeout has not expired and tx may only be cancelled by srouter
                require(msg.sender == txData.router, "cancel: ROUTER_MUST_CANCEL");
            }
            // Return to user
            require(LibAsset.transferAsset(txData.sendingAssetId, payable(txData.user), txData.amount), "cancel: TRANSFER_FAILED");

        } else {
            // Receiver side --> funds go back to router
            if (txData.expiry >= block.timestamp) {
                // Timeout has not expired and tx may only be cancelled by user
                // Validate signature
                require(recoverCancelSignature(txData, signature) == txData.user, "cancel: INVALID_SIGNATURE");
            }
            // Return to router
            routerBalances[txData.router][txData.receivingAssetId] += txData.amount;
        }

        // Remove the active transaction
        activeTransactions.removeTransaction(digest);

        // Emit event
        emit TransactionCancelled(txData, msg.sender);

        // Return
        return txData;
    }

    // Private functions
    function recoverFulfillSignature(
      TransactionData calldata txData,
      uint256 relayerFee,
      bytes calldata signature
    ) internal pure returns (address) {
      // Create the digest
      bytes32 txDigest = hashTransactionData(txData);

      // Create the signed payload
      SignedFulfillData memory payload = SignedFulfillData({
        txDigest: txDigest,
        relayerFee: relayerFee
      });

      // Recover
      return ECDSA.recover(keccak256(abi.encode(payload)), signature);
    }

    function recoverCancelSignature(
      TransactionData calldata txData,
      bytes calldata signature
    ) internal pure returns (address) {
      // Create the digest
      bytes32 txDigest = hashTransactionData(txData);

      // Create the signed payload
      SignedCancelData memory payload = SignedCancelData({
        txDigest: txDigest,
        cancel: "cancel"
      });

      // Recover
      return ECDSA.recover(keccak256(abi.encode(payload)), signature);
    }

    function hashTransactionData(TransactionData calldata txData)
        internal
        pure
        returns (bytes32)
    {
        InvariantTransactionData memory data = InvariantTransactionData({
          user: txData.user,
          router: txData.router,
          sendingAssetId: txData.sendingAssetId,
          receivingAssetId: txData.receivingAssetId,
          sendingChainId: txData.sendingChainId,
          receivingChainId: txData.receivingChainId,
          receivingAddress: txData.receivingAddress,
          callData: txData.callData,
          transactionId: txData.transactionId
        });
        return keccak256(abi.encode(data));
    }
}