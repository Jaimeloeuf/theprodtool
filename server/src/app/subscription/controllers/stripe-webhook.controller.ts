import {
  Controller,
  Logger,
  Post,
  HttpCode,
  Headers,
  RawBodyRequest,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import type { Stripe } from 'stripe';

import {
  IStripeWebhookEventRepo,
  IStripeCustomerRepo,
} from '../../../DAL/index.js';
import { SubscriptionService } from '../services/subscription.service.js';
import { StripeService } from '../services/stripe.service.js';

// Entity Types
import type {
  InvoicePaidEventData,
  CheckoutSessionEventData,
} from '../../../types/index.js';

// Exception Filters
import { UseHttpControllerFilters } from '../../../exception-filters/index.js';

/**
 */
@Controller('subscription')
@UseHttpControllerFilters
export class StripeWebhookController {
  constructor(
    private readonly logger: Logger,
    private readonly stripeWebhookEventRepo: IStripeWebhookEventRepo,
    private readonly stripeCustomerRepo: IStripeCustomerRepo,
    private readonly subscriptionService: SubscriptionService,
    private readonly stripeService: StripeService,
  ) {}

  /**
   * URL --> $HOSTNAME/v1/subscription/stripe/webhook
   */
  @Post('stripe/webhook')
  @HttpCode(200) // Stripe needs this for receipt of event acknowledgement
  async stripeWebhookHandler(
    @Headers('stripe-signature') stripeSignature: string,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<void> {
    if (!stripeSignature)
      throw new BadRequestException(`Missing 'stripe-signature' header`);

    const rawRequestBody = req.rawBody;

    if (rawRequestBody === undefined)
      throw new BadRequestException(`Missing request body`);

    // Use setTimeout to simulate a 'defer' operation so that this can respond
    // back to Stripe ASAP with a 200 status code as specified by Stripe's
    // Webhook best practices.
    //
    // Reference: https://stripe.com/docs/webhooks#webhook-endpoint-def
    // 'Quickly returns successful status code (2xx) prior to any complex logic
    // that could cause a timeout. For example, you must return a 200 response
    // before updating a customer's invoice as paid in your accounting system.'
    setTimeout(() => this.handleEvent(rawRequestBody, stripeSignature));
  }

  /**
   * Handle a Stripe Webhook Event
   *
   * 1. Validate event using webhook signatures
   * 1. Ensure indempotency of event processing
   * 1. Dispatch specific event's handlers
   */
  private async handleEvent(rawRequestBody: Buffer, stripeSignature: string) {
    const event = await this.stripeService.verifyAndConstructEvent(
      rawRequestBody,
      stripeSignature,
    );

    // Check with data persistence layer if the event has been processed before.
    // Doing this because this method should be idempotent.
    // Reference: https://stripe.com/docs/webhooks#handle-duplicate-events
    const eventIsUnprocessed = await this.stripeWebhookEventRepo.isUnprocessed(
      event.id,
      event.type,
      event.livemode,
    );

    // Do indempotency check, if event is already processed before, ignore it.
    if (!eventIsUnprocessed) {
      // @todo
      // Indempotency check might also trigger a background job with setTimeout
      // to delete events older than X (e.g. 30) days so that the DB does not
      // grow unconstrained overtime.
      return;
    }

    await this.processEvent(event);
  }

  /**
   * Process event
   *
   * 1. Logging (log event.id and event.type)
   * 1. Dispatch specific event's handlers
   */
  private async processEvent(event: Stripe.Event) {
    const modeString = event.livemode ? 'live' : 'test';

    this.logger.verbose(
      `Processing '${modeString}' Stripe event: ${event.id} -> ${event.type}`,
      StripeWebhookController.name,
    );

    // Use the `eventHandlerMapping` to get the specific event handler based on
    // `event.type`, in a dynamic dispatch style.
    const eventHandler = this.eventHandlerMapping[event.type];

    // If there is a event handler registered for the event.type, call the
    // handler with the event object and await for completion before returning.
    if (eventHandler !== undefined) {
      await eventHandler(event);
    }

    // If no event handler is registered for the event.type but Stripe is
    // configured to send a event of that event.type, log it out as a potential
    // issue / warning. Configure what events to be sent to the Webhook endpoint
    // in Stripe to ensure only required events are sent.
    else {
      this.logger.warn(
        `Unhandled '${modeString}' Stripe event: ${event.id} -> ${event.type}`,
        StripeWebhookController.name,
      );
    }
  }

  /**
   * A mapping of `event.type` strings to event handler methods.
   *
   * To add a new mapping, make sure the event is sent by Stripe by configuring
   * the webhook settings in Stripe dashboard.
   *
   * All the possible Webhook event types:
   * https://stripe.com/docs/billing/subscriptions/webhooks
   */
  private readonly eventHandlerMapping: Record<
    string,
    (event: Stripe.Event) => void | Promise<void>
  > = {
    // ==================== Activate Subscription Events ====================

    /**
     * TLDR, user has paid for subscription, provision access to product.
     *
     * Event sent when invoice is paid, the system can provision access to the
     * product once it receives this event and after checking to ensure that the
     * subscription status is active.
     *
     * This event is sent both on the first time the subscription is paid for,
     * and also after every subsequent successful payment, so system should
     * continue to provision access to the product as payments continue to be
     * made. Store the status in database and check when a user accesses your
     * service to avoid hitting Stripe API rate limits.
     */
    'invoice.paid': async (event) => {
      /**
       * Stripe library does not define concrete type for this so it needs to be
       * type casted manually. Type only includes data of what is needed.
       */
      const invoicePaidEventData = event.data.object as InvoicePaidEventData;

      const stripeCustomer =
        await this.stripeCustomerRepo.getCustomerWithStripeCustomerID(
          invoicePaidEventData.customer,
        );

      // @todo Send admins details to investigate and manually recouncil this
      if (stripeCustomer === null) {
        throw new Error(
          `${event.id}-${event.type}-${invoicePaidEventData.subscription}-${invoicePaidEventData.customer}-${invoicePaidEventData.customer_email}`,
        );
      }

      // Provision access to the product
      await this.subscriptionService.activateSubscription(stripeCustomer.orgID);
    },

    /**
     * TLDR, user has paid for subscription the very first time, store their
     * details and provision access to product.
     *
     * Event sent when Stripe Checkout Session is successfully completed, the
     * event will include details like `customer.id` and `subscription.id` which
     * should be stored in database for future reference and use. The system can
     * start to provision access to the product.
     */
    'checkout.session.completed': async (event) => {
      /**
       * Stripe library does not define concrete type for this so it needs to be
       * type casted manually. Type only includes data of what is needed.
       */
      const checkoutSessionEventData = event.data
        .object as CheckoutSessionEventData;

      /**
       * `OrgID` is passed to Stripe for it to reflect back on successful
       * checkout sessions in `StripeService.createCheckoutSession`.
       */
      const orgID = checkoutSessionEventData.client_reference_id;

      // If `orgID` is somehow not passed to Stripe during createCheckoutSession
      // this is an inconsistency that must be resolved manually by admins.
      // @todo Send admins details to investigate and manually recouncil this
      if (orgID === undefined) {
        throw new Error(
          `${event.id}-${event.type}-${checkoutSessionEventData.customer}-${checkoutSessionEventData.subscription}--${checkoutSessionEventData.customer_email}`,
        );
      }

      // Create a new Stripe Customer record in Data Source.
      await this.stripeCustomerRepo.createOne(
        orgID,

        // Stripe Customer ID
        checkoutSessionEventData.customer,

        // Stripe Subscription ID
        checkoutSessionEventData.subscription,
      );

      // Provision access to the product
      await this.subscriptionService.activateSubscription(orgID);
    },

    /**
     * Event sent when a subscription previously in a paused status is resumed.
     */
    'customer.subscription.resumed': (event) => {
      event;
      this.subscriptionService.activateSubscription;
    },

    // ==================== Deactivate Subscription Events ====================

    /**
     * TLDR, subscription payment failed, stop provisioning access to product.
     *
     * Event sent when a payment for an invoice failed, either because the
     * payment failed or the customer does not have a valid payment method.
     * The subscription becomes past_due. Stripe suggests to notify customer and
     * send them to the Stripe Customer Billing portal to update their payment
     * information and revoke their access to the product
     *
     * If a payment fails, there are several possible actions to take:
     * 1. Notify the customer, configure subscription settings to enable Smart
     *    Retries and other revenue recovery features.
     * 1. https://stripe.com/docs/billing/subscriptions/overview#settings
     * 1. https://stripe.com/docs/billing/revenue-recovery/smart-retries
     */
    'invoice.payment_failed': (event) => {
      event;
      this.subscriptionService.deactivateSubscription;
    },

    /**
     * TLDR, customer's subscription ended, stop provisioning access to product.
     *
     * Event sent when a customer's subscription ends.
     */
    'customer.subscription.deleted': (event) => {
      event;
      this.subscriptionService.deactivateSubscription;
    },

    /**
     * TLDR, customer's subscription ended, stop provisioning access to product.
     *
     * Event sent when a subscription schedule is canceled, which also cancels
     * any active associated subscription.
     */
    'subscription_schedule.canceled': (event) => {
      event;
      this.subscriptionService.deactivateSubscription;
    },

    /**
     * TLDR, customer's subscription ended, stop provisioning access to product.
     *
     * Event sent when a subscription schedule is canceled because payment
     * delinquency terminated the related subscription.
     */
    'subscription_schedule.aborted': (event) => {
      event;
      this.subscriptionService.deactivateSubscription;
    },

    /**
     * TLDR, customer's subscription paused, stop provisioning access to product.
     *
     * Event sent when a subscription is configured to pause when a free trial
     * ends without a payment method
     */
    'customer.subscription.paused': (event) => {
      event;
      this.subscriptionService.deactivateSubscription;
    },

    // =================== Other Subscription related Events ===================

    /**
     * TLDR, customer's subscription status updated.
     *
     * Event sent when a subscription starts or changes. For example, renewing a
     * subscription, adding a coupon, applying a discount, adding an invoice
     * item, and changing plans all trigger this event.
     * https://stripe.com/docs/billing/subscriptions/change
     */
    'customer.subscription.updated': () => undefined,

    /**
     * TLDR, customer's subscription trial is .
     *
     * Event sent if product has a free trial period and the subscription trial
     * is ending.
     */
    'customer.subscription.trial_will_end': () => undefined,
  };
}
