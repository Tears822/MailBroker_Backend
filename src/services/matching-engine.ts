import { prisma } from '../database/prisma-client';
import { redisUtils } from '../config/redis';
import { WebSocketService } from './websocket';
import { sendWhatsAppMessage } from './whatsapp';

// Remove the PendingApproval interface, pendingSellerApprovals, handleSellerApprovalResponse, and cleanupExpiredPendingTrades
// Only keep the new negotiation logic and partial fill logic

export class MatchingEngine {
  private wsService: WebSocketService;
  private isRunning: boolean = false;
  private matchingInterval: NodeJS.Timeout | null = null;
  private processingInterval: number = 5000; // 5 seconds - much faster for real-time experience
  private pendingPartialFills: Map<string, NodeJS.Timeout> = new Map();
  // Negotiation state per asset
  private negotiationState: Map<string, {
    bestBid: any;
    bestOffer: any;
    turn: 'BID' | 'OFFER';
    timeout: NodeJS.Timeout | null;
  }> = new Map();
  
  // Quantity confirmation state
  private pendingConfirmations: Map<string, {
    confirmationKey: string;
    asset: string;
    bidOrder: any;
    offerOrder: any;
    smallerParty: 'BUYER' | 'SELLER';
    smallerQuantity: number;
    largerQuantity: number;
    additionalQuantity: number;
    timeout: NodeJS.Timeout;
    createdAt: Date;
    // New fields for two-step approval
    state?: 'AWAITING_SMALLER' | 'AWAITING_LARGER';
    smallerPartyResponse?: boolean;
  }> = new Map();

  // Cache for active orders to reduce database hits
  private lastOrdersCache: any[] = [];
  private lastCacheTime: number = 0;
  private cacheValidityMs: number = 30000; // 30 seconds cache

  private declinedPartialFills: Set<string> = new Set();

  constructor(wsService: WebSocketService) {
    this.wsService = wsService;
  }

  /**
   * Send WhatsApp notification to user by userId
   */
  private async notifyUserViaWhatsApp(userId: string, message: string): Promise<void> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { phone: true, username: true }
      });
      
      if (user?.phone) {
        await sendWhatsAppMessage(user.phone, message);
        console.log(`📱 WhatsApp notification sent to ${user.username}: ${message.substring(0, 50)}...`);
      } else {
        console.log(`[WHATSAPP] No phone number found for user ${userId}`);
      }
    } catch (error) {
      console.error('[WHATSAPP] Error sending notification:', error);
    }
  }

  /**
   * Send market status update to all users with active orders in an asset
   */
  private async broadcastMarketStatusToWhatsApp(asset: string, message: string): Promise<void> {
    try {
      // Get all users with active orders for this asset
      const activeOrders = await prisma.order.findMany({
        where: {
          asset,
          status: 'ACTIVE',
          remaining: { gt: 0 }
        },
        include: {
          user: {
            select: { phone: true, username: true }
          }
        }
      });

      // Get unique users and send notifications
      const uniqueUsers = new Map();
      activeOrders.forEach(order => {
        if (order.user?.phone && !uniqueUsers.has(order.user.phone)) {
          uniqueUsers.set(order.user.phone, order.user.username);
        }
      });

      const marketMessage = `📊 ${asset.toUpperCase()} MARKET UPDATE: ${message}`;
      
      for (const [phone, username] of uniqueUsers) {
        await sendWhatsAppMessage(phone, marketMessage);
        console.log(`📱 Market update sent to ${username}`);
      }
      
      console.log(`[WHATSAPP] Market status broadcast sent to ${uniqueUsers.size} users for ${asset}`);
    } catch (error) {
      console.error('[WHATSAPP] Error broadcasting market status:', error);
    }
  }

  public start(): void {
    if (this.isRunning) return;
    
    this.isRunning = true;
    console.log('🚀 Starting real-time matching engine...');

    // Start with a longer delay
    setTimeout(() => {
      this.matchingInterval = setInterval(() => {
        this.processMatching();
      }, this.processingInterval);
    }, 10000); // 10 second initial delay
  }

  public stop(): void {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    if (this.matchingInterval) {
      clearInterval(this.matchingInterval);
      this.matchingInterval = null;
    }
    console.log('🛑 Matching engine stopped');
  }

  private async processMatching(): Promise<void> {
    try {
      // Update last run timestamp for health check
      await redisUtils.set('matching:last_run', new Date().toISOString(), 600); // 10 minutes TTL
      
      // Robust Redis flag logic
      let hasActiveOrders = await redisUtils.get('matching:has_active_orders');
      let activeOrders = [];

      if (hasActiveOrders) {
        activeOrders = await this.getActiveOrders();
      } else {
        // Redis flag is missing or false, check DB directly
        activeOrders = await this.getActiveOrders();
        if (activeOrders.length > 0) {
          await redisUtils.set('matching:has_active_orders', true, 300);
        } else {
          await redisUtils.set('matching:has_active_orders', false, 300);
          console.log('📭 No active orders, skipping matching cycle');
          return; // No active orders, skip matching
        }
      }

      if (activeOrders.length === 0) {
        // Optionally, you can still set the Redis flag here if you want
        // await redisUtils.set('matching:has_active_orders', false, 300); // 5 minutes
        return;
      }

      // Process matching in memory
      await this.processMatchingInMemory(activeOrders);
      
    } catch (error) {
      console.error('Error in matching engine:', error);
    }
  }

  private async getActiveOrders(): Promise<any[]> {
    try {
      // Use cache if it's still valid
      const now = Date.now();
      if (this.lastCacheTime && (now - this.lastCacheTime) < this.cacheValidityMs) {
        console.log(`📋 Using cached orders (${this.lastOrdersCache.length} orders)`);
        return this.lastOrdersCache;
      }

      // Fetch fresh data with optimized query
      const orders = await prisma.order.findMany({
        where: {
          status: 'ACTIVE',
          remaining: { gt: 0 }
        },
        select: {
          id: true,
          action: true,
          price: true,
          asset: true,
          remaining: true,
          userId: true,
          createdAt: true
        },
        orderBy: [
          { asset: 'asc' }, // Group by asset first for better processing
          { price: 'desc' },
          { createdAt: 'asc' }
        ]
      });

      // Update cache
      this.lastOrdersCache = orders;
      this.lastCacheTime = now;
      
      console.log(`📋 Fetched ${orders.length} active orders from database`);
      return orders;
    } catch (error) {
      console.error('Error getting active orders:', error);
      return this.lastOrdersCache; // Return cached data on error
    }
  }

  // Invalidate cache when orders are updated
  private invalidateCache(): void {
    this.lastCacheTime = 0;
    this.lastOrdersCache = [];
  }

  private async processMatchingInMemory(orders: any[]): Promise<void> {
    // Group by asset for more efficient processing
    const ordersByAsset: Record<string, any[]> = {};
    
    for (const order of orders) {
      if (!ordersByAsset[order.asset]) {
        ordersByAsset[order.asset] = [];
      }
      ordersByAsset[order.asset].push(order);
    }

    console.log(`🔍 Processing ${Object.keys(ordersByAsset).length} assets with ${orders.length} total orders`);

    // Process assets with the most orders first (likely more active markets)
    const assetEntries = Object.entries(ordersByAsset).sort((a, b) => b[1].length - a[1].length);

    // Process each asset
    for (const [asset, assetOrders] of assetEntries) {
      await this.processAssetMatching(asset, assetOrders);
    }
  }

  private async processAssetMatching(asset: string, orders: any[]): Promise<void> {
    const bids = orders.filter(order => order.action === 'BID');
    const offers = orders.filter(order => order.action === 'OFFER');

    if (bids.length === 0 || offers.length === 0) {
      console.log(`[MATCHING] No bids or offers for asset ${asset}`);
      return;
    }

    // Find best bid and best offer
    const bestBid = bids.sort((a, b) => Number(b.price) - Number(a.price) || a.createdAt - b.createdAt)[0];
    const bestOffer = offers.sort((a, b) => Number(a.price) - Number(b.price) || a.createdAt - b.createdAt)[0];

    // Check if prices match for potential trade
    if (Number(bestBid.price) === Number(bestOffer.price)) {
      const bidQuantity = Number(bestBid.remaining);
      const offerQuantity = Number(bestOffer.remaining);
      
      console.log(`[MATCHING] Price match found for ${asset}: Bid ${bidQuantity} @ ${bestBid.price}, Offer ${offerQuantity} @ ${bestOffer.price}`);
      
      // Check for quantity mismatch
      if (bidQuantity !== offerQuantity) {
        const smallerQuantity = Math.min(bidQuantity, offerQuantity);
        const largerQuantity = Math.max(bidQuantity, offerQuantity);
        const additionalQuantity = largerQuantity - smallerQuantity;
        
        // Determine which party has the smaller quantity (they get asked to increase)
        const smallerParty = bidQuantity < offerQuantity ? 'BUYER' : 'SELLER';
        const smallerOrder = bidQuantity < offerQuantity ? bestBid : bestOffer;
        const largerOrder = bidQuantity < offerQuantity ? bestOffer : bestBid;
        
        console.log(`[MATCHING] Quantity mismatch detected: ${smallerParty} has ${smallerQuantity}, other party has ${largerQuantity}. Asking ${smallerParty} if they want additional ${additionalQuantity} lots.`);
        
        // Create a pending quantity confirmation
        const confirmationKey = `${asset}:${bestBid.id}:${bestOffer.id}`;
        
        // Debug: Check for existing confirmation
        if (this.pendingConfirmations.has(confirmationKey)) {
          console.log(`[MATCHING][DEBUG] Confirmation already pending for ${confirmationKey}, skipping duplicate request. State:`, this.pendingConfirmations.get(confirmationKey)?.state);
          return;
        }
        
        // Robust: Check if this pair was previously declined
        if (this.declinedPartialFills.has(confirmationKey)) {
          console.log(`[MATCHING][DEBUG] Skipping partial fill for ${confirmationKey} as it was previously declined.`);
          return;
        }
        
        // Create timeout for the confirmation (30 seconds)
        const timeout = setTimeout(() => {
          console.log(`[MATCHING] Quantity confirmation timeout for ${confirmationKey}, proceeding with partial trade`);
          this.handleQuantityConfirmationResponse(confirmationKey, false);
        }, 60000); // 60 seconds - increased timeout for better user experience
        
        // Store pending confirmation
        this.pendingConfirmations.set(confirmationKey, {
          confirmationKey,
          asset,
          bidOrder: bestBid,
          offerOrder: bestOffer,
          smallerParty,
          smallerQuantity,
          largerQuantity,
          additionalQuantity,
          timeout,
          createdAt: new Date(),
          state: 'AWAITING_SMALLER',
        });
        
        // Send confirmation request to the smaller party
        this.wsService.notifyUser(smallerOrder.userId, 'quantity:confirmation_request', {
          confirmationKey,
          asset,
          yourOrderId: smallerOrder.id,
          counterpartyOrderId: largerOrder.id,
          yourQuantity: smallerQuantity,
          counterpartyQuantity: largerQuantity,
          additionalQuantity,
          price: bestBid.price, // Trade price
          side: smallerParty === 'BUYER' ? 'BUY' : 'SELL',
          message: `Do you want to ${smallerParty === 'BUYER' ? 'buy' : 'sell'} ${additionalQuantity} additional lots at $${bestBid.price}? (Total would be ${largerQuantity} lots instead of ${smallerQuantity} lots)`
        });
        
        // 📱 WhatsApp notification for quantity confirmation
        const whatsappMessage = `🤝 QUANTITY CONFIRMATION NEEDED
        
${asset.toUpperCase()} @ $${bestBid.price}
Your order: ${smallerQuantity} lots
Available: ${largerQuantity} lots

Do you want ${additionalQuantity} additional lots?
Reply "YES ${smallerOrder.id.slice(0, 8)}" to accept
Reply "NO ${smallerOrder.id.slice(0, 8)}" to proceed with ${smallerQuantity} lots only

⏰ You have 60 seconds to respond.`;
        
        await this.notifyUserViaWhatsApp(smallerOrder.userId, whatsappMessage);
        
        return; // Wait for confirmation before proceeding
      }
      
      // If quantities match exactly, proceed with immediate execution
      await this.executeMatch(bestBid, bestOffer);
      return;
    }

    // 🔥 NEW: Send competitive bidding alerts when prices don't match but are close
    if (Number(bestBid.price) < Number(bestOffer.price)) {
      // Prices don't match - send competitive bidding alerts
      await this.sendCompetitiveBiddingAlerts(asset, bestBid, bestOffer);
    }

    // If no negotiation state, start one
    if (!this.negotiationState.has(asset)) {
      this.negotiationState.set(asset, {
        bestBid,
        bestOffer,
        turn: 'OFFER', // Offer responds to new best bid
        timeout: null
      });
      this.notifyNegotiation(asset);
      return;
    }

    // If best bid/offer changed, update negotiation state and notify
    const state = this.negotiationState.get(asset)!;
    let updated = false;
    if (bestBid.id !== state.bestBid.id) {
      state.bestBid = bestBid;
      state.turn = 'OFFER';
      updated = true;
    }
    if (bestOffer.id !== state.bestOffer.id) {
      state.bestOffer = bestOffer;
      state.turn = 'BID';
      updated = true;
    }
    if (updated) {
      if (state.timeout) clearTimeout(state.timeout);
      this.notifyNegotiation(asset);
      return;
    }
  }

  // Notify the counterparty in negotiation
  private async notifyNegotiation(asset: string) {
    const state = this.negotiationState.get(asset);
    if (!state) return;
    const { bestBid, bestOffer, turn } = state;
    // Fetch usernames if not present
    let bestBidUsername = bestBid.user?.username;
    let bestOfferUsername = bestOffer.user?.username;
    if (!bestBidUsername || !bestOfferUsername) {
      const [bidUser, offerUser] = await Promise.all([
        prisma.user.findUnique({ where: { id: bestBid.userId } }),
        prisma.user.findUnique({ where: { id: bestOffer.userId } })
      ]);
      bestBidUsername = bestBidUsername || bidUser?.username || '';
      bestOfferUsername = bestOfferUsername || offerUser?.username || '';
    }
    if (turn === 'OFFER') {
      this.wsService.notifyUser(bestOffer.userId, 'negotiation:your_turn', {
        asset,
        bestBid: bestBid.price,
        bestOffer: bestOffer.price,
        bestBidUserId: bestBid.userId,
        bestOfferUserId: bestOffer.userId,
        bestBidUsername,
        bestOfferUsername,
        turn: 'OFFER',
        message: `A new best bid (${bestBid.price}) is available for ${asset}. Improve your offer or pass.`
      });
    } else {
      this.wsService.notifyUser(bestBid.userId, 'negotiation:your_turn', {
        asset,
        bestBid: bestBid.price,
        bestOffer: bestOffer.price,
        bestBidUserId: bestBid.userId,
        bestOfferUserId: bestOffer.userId,
        bestBidUsername,
        bestOfferUsername,
        turn: 'BID',
        message: `A new best offer (${bestOffer.price}) is available for ${asset}. Improve your bid or pass.`
      });
    }
    // Set timeout for response (e.g., 30 seconds)
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = setTimeout(() => {
      // On timeout, broadcast to all and clear negotiation
      this.wsService.broadcastMarketUpdate({
        asset,
        bestBid: bestBid.price,
        bestOffer: bestOffer.price,
        message: `Market for ${asset}: ${bestBid.price} (bid) / ${bestOffer.price} (offer)`
      });
      this.negotiationState.delete(asset);
    }, 30000);
  }

  // Call this when a user improves their price or passes
  public async handleNegotiationResponse(asset: string, userId: string, improved: boolean, newPrice?: number) {
    const state = this.negotiationState.get(asset);
    if (!state) return;
    if (state.timeout) clearTimeout(state.timeout);
    // If improved, update the user's order price if newPrice is provided
    if (improved && newPrice !== undefined) {
      // Determine if user is bestBid or bestOffer
      let orderToUpdate = null;
      if (state.turn === 'OFFER' && state.bestOffer.userId === userId) {
        orderToUpdate = state.bestOffer;
      } else if (state.turn === 'BID' && state.bestBid.userId === userId) {
        orderToUpdate = state.bestBid;
      }
      if (orderToUpdate) {
        await prisma.order.update({
          where: { id: orderToUpdate.id },
          data: { price: newPrice }
        });
      }
      // After update, refetch best bid/offer and continue negotiation
      const orders = await this.getActiveOrders();
      await this.processAssetMatching(asset, orders.filter(o => o.asset === asset));
      return;
    }
    // If improved (but no new price), switch turn and notify
    if (improved) {
      state.turn = state.turn === 'BID' ? 'OFFER' : 'BID';
      this.notifyNegotiation(asset);
    } else {
      // If not improved, broadcast to all and clear negotiation
      this.wsService.broadcastMarketUpdate({
        asset,
        bestBid: state.bestBid.price,
        bestOffer: state.bestOffer.price,
        message: `Market for ${asset}: ${state.bestBid.price} (bid) / ${state.bestOffer.price} (offer)`
      });
      this.negotiationState.delete(asset);
    }
  }

  // Handle quantity confirmation responses
  public async handleQuantityConfirmationResponse(confirmationKey: string, accepted: boolean, newQuantity?: number) {
    const confirmation = this.pendingConfirmations.get(confirmationKey);
    if (!confirmation) {
      console.log(`[MATCHING][DEBUG] No pending confirmation found for key: ${confirmationKey}`);
      return;
    }
    try {
      clearTimeout(confirmation.timeout);
      // Step 1: Awaiting smaller party
      if (confirmation.state === 'AWAITING_SMALLER') {
        confirmation.smallerPartyResponse = accepted;
        if (accepted && newQuantity) {
          // User accepted and wants to increase their order quantity
          const smallerParty = confirmation.smallerParty;
          if (smallerParty === 'BUYER') {
            await prisma.order.update({ where: { id: confirmation.bidOrder.id }, data: { amount: newQuantity, remaining: newQuantity } });
          } else {
            await prisma.order.update({ where: { id: confirmation.offerOrder.id }, data: { amount: newQuantity, remaining: newQuantity } });
          }
          const updatedBid = await prisma.order.findUnique({ where: { id: confirmation.bidOrder.id } });
          const updatedOffer = await prisma.order.findUnique({ where: { id: confirmation.offerOrder.id } });
          if (updatedBid && updatedOffer) {
            this.pendingConfirmations.delete(confirmationKey);
            await this.executeMatch(updatedBid, updatedOffer);
          }
          console.log(`[MATCHING][DEBUG] Smaller party accepted. Executing match for increased quantity.`);
          return;
        } else {
          // User declined or timeout, now ask the larger party
          confirmation.state = 'AWAITING_LARGER';
          // Set new timeout for larger party
          confirmation.timeout = setTimeout(() => {
            this.handleQuantityConfirmationResponse(confirmationKey, false);
          }, 60000);
          // Notify larger party
          const largerParty = confirmation.smallerParty === 'BUYER' ? 'SELLER' : 'BUYER';
          const largerOrder = confirmation.smallerParty === 'BUYER' ? confirmation.offerOrder : confirmation.bidOrder;
          this.wsService.notifyUser(largerOrder.userId, 'quantity:partial_fill_approval', {
            confirmationKey,
            asset: confirmation.asset,
            yourOrderId: largerOrder.id,
            counterpartyOrderId: confirmation.smallerParty === 'BUYER' ? confirmation.bidOrder.id : confirmation.offerOrder.id,
            yourQuantity: confirmation.largerQuantity,
            partialFillQuantity: confirmation.smallerQuantity,
            price: confirmation.bidOrder.price,
            side: largerParty === 'BUYER' ? 'BUY' : 'SELL',
            message: `Do you want to ${largerParty === 'BUYER' ? 'buy' : 'sell'} only ${confirmation.smallerQuantity} lots at $${confirmation.bidOrder.price}? (Your order is for ${confirmation.largerQuantity} lots)`
          });
          const whatsappMessage = `⚠️ PARTIAL FILL APPROVAL NEEDED\n\n${confirmation.asset.toUpperCase()} @ $${confirmation.bidOrder.price}\nYour order: ${confirmation.largerQuantity} lots\nCounterparty: ${confirmation.smallerQuantity} lots\n\nDo you want to proceed with a partial fill for ${confirmation.smallerQuantity} lots?\nReply "YES ${largerOrder.id.slice(0, 8)}" to accept\nReply "NO ${largerOrder.id.slice(0, 8)}" to keep your order active.\n\n⏰ You have 60 seconds to respond.`;
          await this.notifyUserViaWhatsApp(largerOrder.userId, whatsappMessage);
          console.log(`[MATCHING][DEBUG] Smaller party declined. State set to AWAITING_LARGER. Notified larger party (${largerOrder.userId}).`);
          // Do not delete confirmation yet
          return;
        }
      }
      // Step 2: Awaiting larger party
      if (confirmation.state === 'AWAITING_LARGER') {
        this.pendingConfirmations.delete(confirmationKey);
        if (accepted) {
          console.log(`[MATCHING][DEBUG] Larger party accepted partial fill. Executing match for smaller quantity.`);
          await this.executeMatch(confirmation.bidOrder, confirmation.offerOrder);
        } else {
          // Robust: Mark this pair as declined so it won't be retried
          this.declinedPartialFills.add(confirmationKey);
          console.log(`[MATCHING][DEBUG] Larger party declined partial fill. No trade executed. Confirmation deleted. Marked as declined for this pair.`);
        }
        return;
      }
    } catch (error) {
      console.error('[MATCHING] Error handling quantity confirmation response:', error);
    }
  }

  private async executeMatch(bid: any, offer: any): Promise<void> {
    try {
      const tradeAmount = Math.min(Number(bid.remaining), Number(offer.remaining));
      const tradePrice = Number(offer.price);
      const commission = this.calculateCommission(tradeAmount, tradePrice);

      // Determine the type of match
      const bidQuantity = Number(bid.remaining);
      const offerQuantity = Number(offer.remaining);
      let matchType: 'FULL_MATCH' | 'PARTIAL_FILL_BUYER' | 'PARTIAL_FILL_SELLER';
      
      if (bidQuantity === offerQuantity) {
        matchType = 'FULL_MATCH';
      } else if (bidQuantity < offerQuantity) {
        matchType = 'PARTIAL_FILL_BUYER'; // Buyer gets filled, seller has remaining
      } else {
        matchType = 'PARTIAL_FILL_SELLER'; // Seller gets filled, buyer has remaining
      }

      console.log('[MATCHING] Attempting to create trade:', {
        asset: bid.asset,
        price: tradePrice,
        amount: tradeAmount,
        buyerOrderId: bid.id,
        sellerOrderId: offer.id,
        commission,
        buyerId: bid.userId,
        sellerId: offer.userId,
        matchType,
        bidQuantity,
        offerQuantity,
        scenario: matchType === 'PARTIAL_FILL_BUYER' ? 'SELLER_QUANTITY_GREATER_THAN_BUYER' : 
                 matchType === 'PARTIAL_FILL_SELLER' ? 'BUYER_QUANTITY_GREATER_THAN_SELLER' : 'EXACT_MATCH'
      });

      // Execute match with optimized transaction
      const result = await prisma.$transaction(async (tx) => {
        // Create trade
        const trade = await tx.trade.create({
          data: {
            asset: bid.asset,
            price: tradePrice,
            amount: tradeAmount,
            buyerOrderId: bid.id,
            sellerOrderId: offer.id,
            commission,
            buyerId: bid.userId,
            sellerId: offer.userId
          }
        });
        console.log('[MATCHING] Trade created:', trade);

        // Update orders in batch
        const bidRemaining = Number(bid.remaining) - tradeAmount;
        const offerRemaining = Number(offer.remaining) - tradeAmount;

        const [updatedBid, updatedOffer] = await Promise.all([
          tx.order.update({
            where: { id: bid.id },
            data: {
              remaining: bidRemaining,
              matched: bidRemaining === 0,
              counterparty: bidRemaining === 0 ? offer.userId : null,
              status: bidRemaining === 0 ? 'MATCHED' : 'ACTIVE'
            }
          }),
          tx.order.update({
            where: { id: offer.id },
            data: {
              remaining: offerRemaining,
              matched: offerRemaining === 0,
              counterparty: offerRemaining === 0 ? bid.userId : null,
              status: offerRemaining === 0 ? 'MATCHED' : 'ACTIVE'
            }
          })
        ]);

        console.log('[MATCHING] Updated orders in batch');

        // Log the specific scenario results
        if (matchType === 'PARTIAL_FILL_BUYER') {
          console.log(`[MATCHING] ✅ SELLER_QUANTITY > BUYER_QUANTITY: Buyer fully filled (${tradeAmount}), Seller has ${offerRemaining} remaining`);
        } else if (matchType === 'PARTIAL_FILL_SELLER') {
          console.log(`[MATCHING] ✅ BUYER_QUANTITY > SELLER_QUANTITY: Seller fully filled (${tradeAmount}), Buyer has ${bidRemaining} remaining`);
        } else {
          console.log(`[MATCHING] ✅ EXACT_MATCH: Both orders fully filled (${tradeAmount})`);
        }

        return { trade, bidRemaining, offerRemaining, updatedBid, updatedOffer, matchType };
      });

      if (!result.trade) {
        console.error('[MATCHING] Trade was not created!');
        return;
      }

      // Invalidate cache after successful trade
      this.invalidateCache();

      // Update order book in Redis and publish events in parallel
      const [, ] = await Promise.all([
        (new (require('./order-book').OrderBookService)()).updateOrderBookInRedis(bid.asset),
        redisUtils.publish('trade:executed', {
          tradeId: result.trade.id,
          asset: result.trade.asset,
          price: result.trade.price,
          amount: result.trade.amount,
          buyerId: result.trade.buyerId,
          sellerId: result.trade.sellerId,
          timestamp: result.trade.createdAt,
          bidFullyMatched: result.bidRemaining === 0,
          offerFullyMatched: result.offerRemaining === 0,
          bidOrderId: bid.id,
          offerOrderId: offer.id,
          matchType: result.matchType,
          partialFill: result.matchType !== 'FULL_MATCH'
        })
      ]);

      console.log('[MATCHING] Order book updated and trade event published');

      // 🔥 FIXED: Send trade notifications to BOTH parties for ALL trades (including partial fills)
      Promise.all([
        this.sendTradeExecutedNotification(bid, result.trade, 'buyer', result.bidRemaining),
        this.sendTradeExecutedNotification(offer, result.trade, 'seller', result.offerRemaining)
      ]).catch(error => {
        console.error('[MATCHING] Error sending trade notifications:', error);
      });

      console.log(`💱 Trade executed: ${tradeAmount} ${bid.asset} @ ${tradePrice}`);
    } catch (error) {
      console.error('[MATCHING] Error executing match:', error);
    }
  }

  // 🔥 NEW: Enhanced trade notification method that handles both full and partial fills
  private async sendTradeExecutedNotification(order: any, trade: any, side: 'buyer' | 'seller', remainingAmount: number): Promise<void> {
    try {
      const isFullyFilled = remainingAmount === 0;
      const isPartialFill = !isFullyFilled;
      
      // WebSocket notification
      this.wsService.notifyUser(order.userId, 'trade:executed', {
        orderId: order.id,
        asset: order.asset,
        price: trade.price,
        amount: trade.amount,
        tradeId: trade.id,
        side,
        isFullyFilled,
        isPartialFill,
        remainingAmount,
        originalAmount: order.amount
      });
      
      // 📱 WhatsApp notification - enhanced for partial fills
      let message = '';
      if (isFullyFilled) {
        message = `✅ TRADE EXECUTED! 

${order.asset.toUpperCase()} ${side === 'buyer' ? 'Purchase' : 'Sale'} COMPLETE
Amount: ${trade.amount} lots
Price: $${trade.price} per lot
Total: $${(trade.amount * trade.price).toFixed(2)}
Order ID: ${order.id.slice(0, 8)}
Trade ID: ${trade.id.slice(0, 8)}

🎉 Your order has been FULLY executed!`;
      } else {
        message = `✅ TRADE EXECUTED!

${order.asset.toUpperCase()} ${side === 'buyer' ? 'Purchase' : 'Sale'} - PARTIAL FILL
Traded: ${trade.amount} lots
Price: $${trade.price} per lot
Total: $${(trade.amount * trade.price).toFixed(2)}
Remaining: ${remainingAmount} lots still active
Order ID: ${order.id.slice(0, 8)}
Trade ID: ${trade.id.slice(0, 8)}

⏳ Your order remains active for the remaining ${remainingAmount} lots.`;
      }
      
      await this.notifyUserViaWhatsApp(order.userId, message);
    } catch (error) {
      console.error(`[MATCHING] Error sending ${side} trade notification:`, error);
    }
  }

  // Helper method to send order matched notifications (kept for backward compatibility)
  private async sendOrderMatchedNotification(order: any, trade: any, side: 'buyer' | 'seller'): Promise<void> {
    try {
      this.wsService.notifyUser(order.userId, 'order:matched', {
        orderId: order.id,
        status: 'MATCHED',
        asset: order.asset,
        price: trade.price,
        amount: trade.amount,
        tradeId: trade.id,
        side
      });
      
      // WhatsApp notification
      const message = `✅ ORDER MATCHED!

${order.asset.toUpperCase()} ${side === 'buyer' ? 'Purchase' : 'Sale'} Complete
Amount: ${trade.amount} lots
Price: $${trade.price} per lot
Total: $${(trade.amount * trade.price).toFixed(2)}
Order ID: ${order.id.slice(0, 8)}
Trade ID: ${trade.id.slice(0, 8)}

Your order has been fully executed.`;
      
      await this.notifyUserViaWhatsApp(order.userId, message);
    } catch (error) {
      console.error(`[MATCHING] Error sending ${side} notification:`, error);
    }
  }

  // 🔥 NEW: Send competitive bidding alerts when there are nearby orders
  public async sendCompetitiveBiddingAlerts(asset: string, bestBid: any, bestOffer: any): Promise<void> {
    try {
      // Only send alerts if bid and offer prices are close but not matching
      const bidPrice = Number(bestBid.price);
      const offerPrice = Number(bestOffer.price);
      
      if (bidPrice >= offerPrice) {
        // Prices match or cross - will be handled by normal matching logic
        return;
      }
      
      // Calculate spread
      const spread = offerPrice - bidPrice;
      const spreadPercentage = (spread / bidPrice) * 100;
      
      // Only send alerts if spread is reasonable (less than 20%)
      if (spreadPercentage > 20) {
        return;
      }
      
      console.log(`[COMPETITIVE] Sending bidding alerts for ${asset}: Bid $${bidPrice} vs Offer $${offerPrice} (spread: ${spread.toFixed(2)})`);
      
      // Alert to bid holder about the offer
      const bidMessage = `💰 COMPETITIVE BIDDING ALERT!

${asset.toUpperCase()}
Your BID: ${bestBid.remaining} lots @ $${bidPrice}
Available OFFER: ${bestOffer.remaining} lots @ $${offerPrice}
Spread: $${spread.toFixed(2)} (${spreadPercentage.toFixed(1)}%)

💡 Consider improving your bid price to $${offerPrice} to trade immediately!
Your Order ID: ${bestBid.id.slice(0, 8)}`;

      // Alert to offer holder about the bid  
      const offerMessage = `💰 COMPETITIVE BIDDING ALERT!

${asset.toUpperCase()}
Your OFFER: ${bestOffer.remaining} lots @ $${offerPrice}
Available BID: ${bestBid.remaining} lots @ $${bidPrice}
Spread: $${spread.toFixed(2)} (${spreadPercentage.toFixed(1)}%)

💡 Consider lowering your offer price to $${bidPrice} to trade immediately!
Your Order ID: ${bestOffer.id.slice(0, 8)}`;

      // Send notifications in parallel
      await Promise.all([
        this.notifyUserViaWhatsApp(bestBid.userId, bidMessage),
        this.notifyUserViaWhatsApp(bestOffer.userId, offerMessage)
      ]);
      
      console.log(`[COMPETITIVE] Sent bidding alerts to bid holder (${bestBid.userId}) and offer holder (${bestOffer.userId})`);
    } catch (error) {
      console.error('[COMPETITIVE] Error sending competitive bidding alerts:', error);
    }
  }

  private calculateCommission(amount: number, price: number): number {
    return Math.round((amount * price * 0.001) * 100) / 100;
  }

  public async getOrderBook(asset: string): Promise<any> {
    try {
      const orders = await prisma.order.findMany({
        where: {
          asset,
          status: 'ACTIVE',
          remaining: { gt: 0 }
        },
        orderBy: [
          { price: 'desc' },
          { createdAt: 'asc' }
        ]
      });

      const bids = orders.filter(order => order.action === 'BID');
      const offers = orders.filter(order => order.action === 'OFFER');

      return {
        asset,
        bids: bids.slice(0, 10),
        offers: offers.slice(0, 10),
        totalBids: bids.length,
        totalOffers: offers.length,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error getting order book:', error);
      return {
        asset,
        bids: [],
        offers: [],
        totalBids: 0,
        totalOffers: 0,
        timestamp: new Date().toISOString()
      };
    }
  }

  // Method to mark that there are active orders (called when orders are created)
  public async markActiveOrders(): Promise<void> {
    await redisUtils.set('matching:has_active_orders', true, 300); // 5 minutes
  }

  // Method to get pending confirmation by order ID part (for WhatsApp responses)
  public getPendingConfirmationByOrderId(orderIdPart: string): string | null {
    for (const [confirmationKey, confirmation] of this.pendingConfirmations) {
      // Check if either bid or offer order ID starts with the provided part
      if (confirmation.bidOrder.id.startsWith(orderIdPart) || 
          confirmation.offerOrder.id.startsWith(orderIdPart)) {
        return confirmationKey;
      }
    }
    return null;
  }

  // Method to check if a user has pending confirmations
  public getUserPendingConfirmations(userId: string): Array<{confirmationKey: string; details: any}> {
    const userConfirmations = [];
    for (const [confirmationKey, confirmation] of this.pendingConfirmations) {
      // Check if this user is the one being asked for confirmation
      const isUserInvolved = (confirmation.smallerParty === 'BUYER' && confirmation.bidOrder.userId === userId) ||
                            (confirmation.smallerParty === 'SELLER' && confirmation.offerOrder.userId === userId);
      
      if (isUserInvolved) {
        userConfirmations.push({
          confirmationKey,
          details: {
            asset: confirmation.asset,
            yourQuantity: confirmation.smallerQuantity,
            availableQuantity: confirmation.largerQuantity,
            additionalQuantity: confirmation.additionalQuantity,
            side: confirmation.smallerParty
          }
        });
      }
    }
    return userConfirmations;
  }

  // Public method to immediately process matching for a specific asset
  public async processAsset(asset: string): Promise<void> {
    try {
      // Fetch active orders for this specific asset
      const orders = await prisma.order.findMany({
        where: {
          asset,
          status: 'ACTIVE',
          remaining: { gt: 0 }
        },
        select: {
          id: true,
          action: true,
          price: true,
          asset: true,
          remaining: true,
          userId: true,
          createdAt: true
        },
        orderBy: [
          { price: 'desc' },
          { createdAt: 'asc' }
        ]
      });

      if (orders.length < 2) {
        console.log(`[MATCHING] Not enough orders for asset ${asset} (${orders.length} orders)`);
        return;
      }

      console.log(`[MATCHING] Immediate processing for asset ${asset} with ${orders.length} orders`);
      
      // Process matching for this specific asset
      await this.processAssetMatching(asset, orders);
      
      // Invalidate cache to force fresh data on next periodic run
      this.invalidateCache();
      
    } catch (error) {
      console.error(`[MATCHING] Error in immediate asset processing for ${asset}:`, error);
    }
  }
} 