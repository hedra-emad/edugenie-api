import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import Stripe from 'stripe';

import { StripeService } from './stripe.service';
import { User } from '../users/schema/user.schema';
import { Course } from '../courses/schema/course.schema';
import { Order } from '../orders/schema/order.schema';
import { Enrollment } from '../enrollments/schema/enrollment.schema';
import { Earning } from '../earnings/schema/earning.schema';
import { PayoutRequest } from '../earnings/schema/payout-request.schema';
import { PlatformConfig } from '../superadmin/schema/platform-config.schema';
import { Notification } from '../notifications/schema/notification.schema';
import { Cart } from '../cart/schema/cart.schema';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/enums/notification-type.enum';
import { CourseStatus } from '../common/enums/course-status.enum';
import { OrderStatus } from '../common/enums/order-status.enum';
import { PurchaseType } from '../common/enums/purchase-type.enum';
import { EarningStatus } from '../common/enums/earning-status.enum';
import { PayoutRequestStatus } from '../common/enums/payout-request-status.enum';
import { UserRole } from '../common/enums/user-role.enum';

const DEFAULT_INSTRUCTOR_SHARE = 80;
const DEFAULT_PLATFORM_FEE = 20;

export interface ConnectStatus {
  hasAccount: boolean;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  balanceAvailable: number;
  balancePending: number;
}

/**
 * Stripe Connect (Express, destination charges) marketplace flow — TEST MODE.
 * Owns onboarding, student checkout, checkout fulfillment (Order + Enrollment +
 * Earning ledger), and instructor payouts. Reused by EarningsService (onboard,
 * status, request) and SuperAdminService (approve/sync a payout).
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Course.name) private courseModel: Model<Course>,
    @InjectModel(Order.name) private orderModel: Model<Order>,
    @InjectModel(Enrollment.name) private enrollmentModel: Model<Enrollment>,
    @InjectModel(Earning.name) private earningModel: Model<Earning>,
    @InjectModel(PayoutRequest.name)
    private payoutRequestModel: Model<PayoutRequest>,
    @InjectModel(PlatformConfig.name)
    private platformConfigModel: Model<PlatformConfig>,
    @InjectModel(Notification.name)
    private notificationModel: Model<Notification>,
    @InjectModel(Cart.name) private cartModel: Model<Cart>,
  ) {}

  get isConfigured(): boolean {
    return this.stripe.isConfigured;
  }

  private get dashboardUrl(): string {
    return (
      this.config.get<string>('DASHBOARD_URL') || 'http://localhost:4200'
    ).replace(/\/$/, '');
  }

  private get studentUrl(): string {
    return (
      this.config.get<string>('STUDENT_APP_URL') || 'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  /** Days funds sit in the instructor's Stripe balance before auto-paying out. */
  private get payoutDelayDays(): number {
    const raw = Number(this.config.get<string>('PAYOUT_DELAY_DAYS'));
    return Number.isFinite(raw) && raw >= 0 ? raw : 7;
  }

  /**
   * Instructor payout countries Stripe can reach from a US platform. Defaults to
   * Stripe's cross-border set; override with SUPPORTED_PAYOUT_COUNTRIES (CSV).
   */
  private get supportedPayoutCountries(): string[] {
    const raw = this.config.get<string>('SUPPORTED_PAYOUT_COUNTRIES');
    if (raw && raw.trim()) {
      return raw
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean);
    }
    return ['US', 'GB', 'CA', 'CH', 'DE', 'FR', 'IE', 'NL', 'ES', 'IT', 'AU'];
  }

  isCountrySupported(country: string): boolean {
    return this.supportedPayoutCountries.includes((country || '').toUpperCase());
  }

  private async getShare(): Promise<{ share: number; fee: number }> {
    const config = await this.platformConfigModel.findOne().lean().exec();
    return {
      share: config?.instructorSharePercent ?? DEFAULT_INSTRUCTOR_SHARE,
      fee: config?.platformFeePercent ?? DEFAULT_PLATFORM_FEE,
    };
  }

  // ---- Connect onboarding ---------------------------------------------------

  /** Create the Express account if needed and return an onboarding link. */
  async onboard(
    instructorId: string,
    country = 'US',
  ): Promise<{ url: string }> {
    if (!this.stripe.isConfigured) {
      throw new ServiceUnavailableException(
        'Stripe is not configured. Set STRIPE_SECRET_KEY.',
      );
    }
    const user = await this.userModel
      .findById(instructorId)
      .select('stripeAccountId email')
      .exec();
    if (!user) throw new NotFoundException('User not found');

    let accountId = user.get('stripeAccountId') as string | null;

    // A stored account can go stale — a Stripe test-data wipe or revoked access
    // leaves a dangling id. Verify it still exists; if not, forget it so we
    // create a fresh one below instead of erroring on a deleted account.
    if (accountId) {
      try {
        await this.stripe.retrieveAccount(accountId);
      } catch {
        this.logger.warn(
          `Stored Stripe account ${accountId} is gone/revoked — recreating.`,
        );
        accountId = null;
        await this.userModel
          .updateOne({ _id: user._id }, { $unset: { stripeAccountId: '' } })
          .exec();
      }
    }

    if (!accountId) {
      // Country gate — Stripe can't pay out everywhere (Rule 4). Only checked
      // when creating a NEW account (the country is fixed once set on Stripe).
      if (!this.isCountrySupported(country)) {
        throw new BadRequestException(
          `Payouts to "${country}" aren't supported yet. Supported: ${this.supportedPayoutCountries.join(', ')}.`,
        );
      }
      accountId = await this.stripe.createExpressAccount(user.email, country);
      await this.userModel
        .updateOne({ _id: user._id }, { $set: { stripeAccountId: accountId } })
        .exec();
    }

    // Put the account on an AUTOMATIC daily payout schedule (idempotent). Stripe
    // then pays the instructor's balance to their bank on its own — no manual
    // payout, no admin approval. Best-effort: don't block onboarding if it fails.
    try {
      await this.stripe.setAutomaticPayoutSchedule(
        accountId,
        this.payoutDelayDays,
      );
    } catch (err) {
      this.logger.warn(
        `setAutomaticPayoutSchedule failed for ${accountId}: ${(err as Error).message}`,
      );
    }

    const url = await this.stripe.createAccountLink(
      accountId,
      `${this.dashboardUrl}/stripe-callback?refresh=1`,
      `${this.dashboardUrl}/stripe-callback`,
    );
    return { url };
  }

  /** One-time login link to the instructor's Stripe Express dashboard. */
  async expressDashboardLink(instructorId: string): Promise<{ url: string }> {
    if (!this.stripe.isConfigured) {
      throw new ServiceUnavailableException(
        'Stripe is not configured. Set STRIPE_SECRET_KEY.',
      );
    }
    const user = await this.userModel
      .findById(instructorId)
      .select('stripeAccountId')
      .lean<{ stripeAccountId?: string | null }>()
      .exec();
    if (!user?.stripeAccountId) {
      throw new BadRequestException('Finish Stripe onboarding first.');
    }
    const url = await this.stripe.createLoginLink(user.stripeAccountId);
    return { url };
  }

  /** Onboarding + capability + balance snapshot for the instructor. */
  async connectStatus(instructorId: string): Promise<ConnectStatus> {
    const empty: ConnectStatus = {
      hasAccount: false,
      detailsSubmitted: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      balanceAvailable: 0,
      balancePending: 0,
    };
    if (!this.stripe.isConfigured) return empty;

    const user = await this.userModel
      .findById(instructorId)
      .select('stripeAccountId')
      .lean<{ stripeAccountId?: string | null }>()
      .exec();
    const accountId = user?.stripeAccountId;
    if (!accountId) return empty;

    try {
      const account = await this.stripe.retrieveAccount(accountId);
      const status: ConnectStatus = {
        hasAccount: true,
        detailsSubmitted: !!account.details_submitted,
        chargesEnabled: !!account.charges_enabled,
        payoutsEnabled: !!account.payouts_enabled,
        balanceAvailable: 0,
        balancePending: 0,
      };
      if (account.payouts_enabled) {
        const balance = await this.stripe.getConnectedBalance(accountId);
        status.balanceAvailable = balance.available;
        status.balancePending = balance.pending;
      }
      return status;
    } catch (err) {
      // A wiped/revoked account throws here — report "no account" so the UI
      // shows "Set up payouts" and onboarding recreates it (rather than getting
      // stuck showing a half-connected state for an account that's gone).
      this.logger.warn(
        `connectStatus failed for ${instructorId} (${accountId}): ${(err as Error).message}`,
      );
      return empty;
    }
  }

  // ---- Student checkout -----------------------------------------------------

  /** Create a destination-charge Checkout Session for a single full course. */
  async checkout(
    buyerId: string,
    courseId: string,
    origin: 'dashboard' | 'student' = 'dashboard',
  ): Promise<{ url: string }> {
    if (!this.stripe.isConfigured) {
      throw new ServiceUnavailableException(
        'Stripe is not configured. Set STRIPE_SECRET_KEY.',
      );
    }
    if (!Types.ObjectId.isValid(courseId)) {
      throw new NotFoundException('Course not found');
    }
    const course = await this.courseModel
      .findById(courseId)
      .select('title price instructorId courseStatus')
      .lean<{
        _id: Types.ObjectId;
        title: string;
        price: number;
        instructorId: Types.ObjectId;
        courseStatus: CourseStatus;
      }>()
      .exec();
    if (!course) throw new NotFoundException('Course not found');

    if (course.instructorId.toString() === buyerId) {
      throw new ForbiddenException('You cannot buy your own course.');
    }
    if (course.courseStatus !== CourseStatus.PUBLISHED) {
      throw new BadRequestException('This course is not available for purchase.');
    }
    if (!course.price || course.price <= 0) {
      throw new BadRequestException('This course is free — nothing to charge.');
    }

    // Already enrolled?
    const owned = await this.enrollmentModel
      .findOne({
        studentId: new Types.ObjectId(buyerId),
        courseId: course._id,
      })
      .lean()
      .exec();
    if (owned) throw new BadRequestException('You already own this course.');

    // Instructor must have finished Stripe onboarding to receive the transfer.
    const instructor = await this.userModel
      .findById(course.instructorId)
      .select('stripeAccountId')
      .lean<{ stripeAccountId?: string | null }>()
      .exec();
    const destination = instructor?.stripeAccountId;
    if (!destination) {
      throw new BadRequestException(
        'The instructor has not set up Stripe payouts yet.',
      );
    }
    let account: Stripe.Account;
    try {
      account = await this.stripe.retrieveAccount(destination);
    } catch {
      // Stored connected account is gone/revoked (e.g. test-data wipe) — the
      // instructor must re-onboard. Clean 400 instead of a raw Stripe 500.
      throw new BadRequestException(
        'The instructor has not set up Stripe payouts yet.',
      );
    }
    if (!account.charges_enabled) {
      throw new BadRequestException(
        'The instructor has not finished Stripe onboarding yet.',
      );
    }

    const priceCents = Math.round(course.price * 100);
    const { fee } = await this.getShare();
    const feeCents = Math.round((priceCents * fee) / 100);

    const returnBase =
      origin === 'student' ? this.studentUrl : this.dashboardUrl;
    const returnPath =
      origin === 'student' ? '/checkout/stripe-success' : '/buy-test';

    const session = await this.stripe.createCheckoutSession({
      courseTitle: course.title,
      priceCents,
      feeCents,
      destinationAccountId: destination,
      // {CHECKOUT_SESSION_ID} is substituted by Stripe — lets the return page
      // confirm+fulfill without relying on the webhook.
      successUrl: `${returnBase}${returnPath}?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${returnBase}${returnPath}?purchase=cancel`,
      metadata: {
        courseId: course._id.toString(),
        buyerId,
        instructorId: course.instructorId.toString(),
      },
      // Include everything that shapes the session so an identical retry is
      // idempotent, but a changed destination/price/fee/origin (e.g. after the
      // instructor re-onboards to a new connected account) gets a fresh key
      // instead of colliding with the old request's parameters.
      idempotencyKey: `checkout_${buyerId}_${course._id.toString()}_${destination}_${priceCents}_${feeCents}_${origin}`,
    });

    if (!session.url) {
      throw new ServiceUnavailableException('Stripe did not return a checkout URL.');
    }
    return { url: session.url };
  }

  /**
   * Confirm + fulfill a checkout from the browser's return redirect, so a paid
   * order is granted even when the `checkout.session.completed` webhook isn't
   * reaching this server (common in local dev). Verifies the session is actually
   * PAID and belongs to the caller, then runs the same idempotent fulfillment the
   * webhook uses — so a later webhook is a harmless no-op.
   */
  async confirmCheckout(
    sessionId: string,
    buyerId: string,
  ): Promise<{ fulfilled: boolean }> {
    if (!this.stripe.isConfigured) {
      throw new ServiceUnavailableException('Stripe is not configured.');
    }
    if (!sessionId) throw new BadRequestException('Missing session id.');

    const session = await this.stripe.retrieveCheckoutSession(sessionId);
    // Only the buyer who created the session may confirm it.
    if (session.metadata?.buyerId && session.metadata.buyerId !== buyerId) {
      throw new ForbiddenException('This checkout is not yours.');
    }
    // Not paid yet (still processing / abandoned) — nothing to fulfill.
    if (session.payment_status !== 'paid') {
      return { fulfilled: false };
    }
    await this.fulfillCheckout(session);
    return { fulfilled: true };
  }

  /**
   * Recover the caller's paid-but-unfulfilled cart orders (e.g. the webhook never
   * arrived). Finds their recent PENDING orders, and for each whose Stripe session
   * is actually PAID, runs the idempotent fulfillment. Returns how many it granted.
   */
  async confirmPendingOrders(buyerId: string): Promise<{ fulfilled: number }> {
    if (!this.stripe.isConfigured) {
      throw new ServiceUnavailableException('Stripe is not configured.');
    }
    const pending = await this.orderModel
      .find({
        studentId: new Types.ObjectId(buyerId),
        status: OrderStatus.PENDING,
        stripeSessionId: { $ne: null },
      })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean<Array<{ stripeSessionId: string | null }>>()
      .exec();

    let fulfilled = 0;
    for (const order of pending) {
      if (!order.stripeSessionId) continue;
      try {
        const session = await this.stripe.retrieveCheckoutSession(
          order.stripeSessionId,
        );
        if (session.payment_status === 'paid') {
          await this.fulfillCheckout(session);
          fulfilled++;
        }
      } catch (err) {
        this.logger.warn(
          `confirmPendingOrders: session ${order.stripeSessionId} failed: ${(err as Error).message}`,
        );
      }
    }
    return { fulfilled };
  }

  /** Fulfill a paid Checkout Session: Order + Enrollment + Earning. Idempotent. */
  async fulfillCheckout(session: Stripe.Checkout.Session): Promise<void> {
    // Whole-cart sessions (separate charges + transfers) carry an orderId and are
    // fulfilled per-item / per-instructor. Single-course destination charges fall
    // through to the legacy path below.
    if (session.metadata?.orderId) {
      await this.fulfillCartOrder(session);
      return;
    }

    const courseId = session.metadata?.courseId;
    const buyerId = session.metadata?.buyerId;
    if (!courseId || !buyerId) {
      this.logger.warn(`checkout.session.completed missing metadata: ${session.id}`);
      return;
    }

    // Idempotency: skip if this session was already fulfilled.
    const existing = await this.orderModel
      .findOne({ stripeSessionId: session.id })
      .lean()
      .exec();
    if (existing) return;

    const course = await this.courseModel
      .findById(courseId)
      .select('title price instructorId')
      .lean<{
        _id: Types.ObjectId;
        title: string;
        price: number;
        instructorId: Types.ObjectId;
      }>()
      .exec();
    if (!course) {
      this.logger.warn(`Fulfillment: course ${courseId} not found`);
      return;
    }

    const studentObjId = new Types.ObjectId(buyerId);
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent?.id ?? null);

    // Stripe's processing fee on this charge — the platform absorbs it.
    const stripeFee = paymentIntentId
      ? await this.stripe.getPaymentFee(paymentIntentId)
      : 0;

    // 1) Order (COMPLETED).
    // The findOne guard above is the fast path; the unique index on
    // stripeSessionId is the real guarantee. If two webhook deliveries race
    // past the guard, the second create hits duplicate-key (11000) — we treat
    // that as "already fulfilled" and return, so nothing is double-processed.
    let order: Awaited<ReturnType<typeof this.orderModel.create>>[number];
    try {
      [order] = await this.orderModel.create([
        {
          studentId: studentObjId,
          items: [
            {
              courseId: course._id,
              itemType: PurchaseType.FULL_COURSE,
              courseTitle: course.title,
              price: course.price,
            },
          ],
          totalAmount: course.price,
          status: OrderStatus.COMPLETED,
          paidAt: new Date(),
          stripeSessionId: session.id,
          stripePaymentIntentId: paymentIntentId,
          stripeFee,
        },
      ]);
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) {
        this.logger.warn(
          `Duplicate fulfillment for session ${session.id} — already handled.`,
        );
        return;
      }
      throw err;
    }

    // 2) Enrollment (full course). Upsert-safe against the unique index.
    try {
      await this.enrollmentModel.create({
        studentId: studentObjId,
        courseId: course._id,
        type: PurchaseType.FULL_COURSE,
        sectionIds: [],
      });
    } catch (err) {
      // Duplicate enrollment (already owned) — ignore.
      this.logger.warn(`Enrollment upsert: ${(err as Error).message}`);
    }

    // 3) Earning ledger entry (instructor share).
    const { share } = await this.getShare();
    const earningAmount = Math.round(course.price * (share / 100) * 100) / 100;
    await this.earningModel.create({
      instructorId: course.instructorId,
      orderId: order._id,
      courseId: course._id,
      sectionId: null,
      amount: earningAmount,
      status: EarningStatus.PENDING,
    });

    // 4) Notifications (best-effort).
    this.notifications
      .create(
        studentObjId,
        'Purchase Successful',
        `You now own "${course.title}". Enjoy!`,
        NotificationType.PURCHASE_COMPLETED,
        course._id.toString(),
      )
      .catch(() => {});
    this.notifications
      .create(
        course.instructorId,
        'New Enrollment',
        `A student just bought "${course.title}".`,
        NotificationType.NEW_ENROLLMENT,
        course._id.toString(),
      )
      .catch(() => {});
    this.notifications
      .create(
        course.instructorId,
        'Earning Recorded',
        `You earned ${earningAmount} from "${course.title}".`,
        NotificationType.EARNING_RECORDED,
        course._id.toString(),
      )
      .catch(() => {});

    // Empty this course from the buyer's cart if it was sitting there.
    await this.clearOrderItemsFromCart(studentObjId, order.items).catch(() => {});
  }

  // ---- Whole-cart checkout (separate charges + transfers) -------------------

  /**
   * Start a Stripe Checkout for the buyer's WHOLE cart in one session. The
   * platform is merchant of record (no per-item destination), so a cart spanning
   * multiple instructors works; `fulfillCartOrder` later issues one Transfer per
   * instructor from the single charge. A PENDING Order is created up front and its
   * id becomes both the Stripe `transfer_group` and the fulfillment lookup key.
   */
  async checkoutCart(
    buyerId: string,
    origin: 'dashboard' | 'student' = 'student',
  ): Promise<{ url: string }> {
    if (!this.stripe.isConfigured) {
      throw new ServiceUnavailableException(
        'Stripe is not configured. Set STRIPE_SECRET_KEY.',
      );
    }

    const buyerObjId = new Types.ObjectId(buyerId);
    const cart = await this.cartModel
      .findOne({ studentId: buyerObjId })
      .lean<{
        items: Array<{
          itemType: PurchaseType;
          courseId: Types.ObjectId;
          sectionId?: Types.ObjectId;
          price: number;
        }>;
      }>()
      .exec();
    if (!cart || cart.items.length === 0) {
      throw new BadRequestException('Your cart is empty.');
    }

    const orderItems: Array<{
      courseId: Types.ObjectId;
      itemType: PurchaseType;
      sectionId?: Types.ObjectId;
      instructorId: Types.ObjectId;
      courseTitle: string;
      price: number;
    }> = [];
    const lineItems: Array<{ name: string; amountCents: number }> = [];
    const instructorIds = new Set<string>();

    for (const item of cart.items) {
      const course = await this.courseModel
        .findById(item.courseId)
        .select('title price instructorId courseStatus sections')
        .lean<{
          _id: Types.ObjectId;
          title: string;
          price: number;
          instructorId: Types.ObjectId;
          courseStatus: CourseStatus;
          sections: Array<{
            _id: Types.ObjectId;
            title: string;
            price?: number | null;
          }>;
        }>()
        .exec();
      if (!course) continue; // stale cart row (course deleted) — skip
      if (course.courseStatus !== CourseStatus.PUBLISHED) continue;
      if (course.instructorId.toString() === buyerId) {
        throw new ForbiddenException('You cannot buy your own course.');
      }

      // Drop anything the buyer already owns so they're never charged for it.
      const owned = await this.enrollmentModel
        .findOne({ studentId: buyerObjId, courseId: course._id })
        .lean<{ type: PurchaseType; sectionIds: Types.ObjectId[] }>()
        .exec();

      let name: string;
      let sectionId: Types.ObjectId | undefined;
      if (item.itemType === PurchaseType.SECTION) {
        if (!item.sectionId) continue;
        const section = course.sections?.find(
          (s) => s._id.toString() === item.sectionId!.toString(),
        );
        if (!section) continue;
        if (owned?.type === PurchaseType.FULL_COURSE) continue;
        if (
          owned?.sectionIds?.some(
            (id) => id.toString() === item.sectionId!.toString(),
          )
        ) {
          continue;
        }
        sectionId = item.sectionId;
        name = `${course.title} — ${section.title}`;
      } else {
        if (owned) continue; // already owns (full, or some sections)
        name = course.title;
      }

      const price = item.price;
      if (!price || price <= 0) continue; // free items don't go through Stripe

      orderItems.push({
        courseId: course._id,
        itemType: item.itemType,
        sectionId,
        instructorId: course.instructorId,
        courseTitle: name,
        price,
      });
      lineItems.push({ name, amountCents: Math.round(price * 100) });
      instructorIds.add(course.instructorId.toString());
    }

    if (orderItems.length === 0) {
      throw new BadRequestException(
        'Nothing to pay for — your cart is empty, free, or already owned.',
      );
    }

    // Every instructor must be onboarded (their Transfer needs a charges-enabled
    // connected account). Fail early, naming who still has to set up payouts.
    const notOnboarded: string[] = [];
    for (const instructorId of instructorIds) {
      const instructor = await this.userModel
        .findById(instructorId)
        .select('stripeAccountId firstName lastName')
        .lean<{
          stripeAccountId?: string | null;
          firstName?: string;
          lastName?: string;
        }>()
        .exec();
      let ok = false;
      if (instructor?.stripeAccountId) {
        try {
          const account = await this.stripe.retrieveAccount(
            instructor.stripeAccountId,
          );
          ok = !!account.charges_enabled;
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        notOnboarded.push(
          `${instructor?.firstName ?? ''} ${instructor?.lastName ?? ''}`.trim() ||
            'an instructor',
        );
      }
    }
    if (notOnboarded.length > 0) {
      throw new BadRequestException(
        `These instructors haven't set up Stripe payouts yet: ${notOnboarded.join(', ')}. Remove their items to check out the rest.`,
      );
    }

    const totalAmount = orderItems.reduce((s, i) => s + i.price, 0);

    const [order] = await this.orderModel.create([
      {
        studentId: buyerObjId,
        items: orderItems,
        totalAmount,
        status: OrderStatus.PENDING,
      },
    ]);
    const orderId = order._id.toString();

    const returnBase =
      origin === 'student' ? this.studentUrl : this.dashboardUrl;
    const returnPath =
      origin === 'student' ? '/checkout/stripe-success' : '/buy-test';

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.createCartCheckoutSession({
        lineItems,
        transferGroup: orderId,
        successUrl: `${returnBase}${returnPath}?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${returnBase}${returnPath}?purchase=cancel`,
        metadata: { orderId, buyerId, kind: 'cart' },
        idempotencyKey: `cart_${orderId}`,
      });
    } catch (err) {
      order.status = OrderStatus.FAILED;
      await order.save();
      throw err;
    }
    if (!session.url) {
      order.status = OrderStatus.FAILED;
      await order.save();
      throw new ServiceUnavailableException(
        'Stripe did not return a checkout URL.',
      );
    }
    order.stripeSessionId = session.id;
    await order.save();
    return { url: session.url };
  }

  /**
   * Fulfill a whole-cart session: complete the Order, create every Enrollment,
   * transfer each instructor's share, record the Earning ledger, and empty the
   * bought items from the cart. Idempotent on order status.
   */
  private async fulfillCartOrder(
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    const orderId = session.metadata?.orderId;
    if (!orderId || !Types.ObjectId.isValid(orderId)) {
      this.logger.warn(`cart checkout: invalid orderId "${orderId}"`);
      return;
    }
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) {
      this.logger.warn(`cart checkout: order ${orderId} not found`);
      return;
    }
    if (order.status === OrderStatus.COMPLETED) return; // idempotent replay

    const studentObjId = order.studentId;
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent?.id ?? null);
    const chargeId = paymentIntentId
      ? await this.stripe.getChargeId(paymentIntentId)
      : null;
    const stripeFee = paymentIntentId
      ? await this.stripe.getPaymentFee(paymentIntentId)
      : 0;

    order.status = OrderStatus.COMPLETED;
    order.paidAt = new Date();
    order.stripeSessionId = session.id;
    order.stripePaymentIntentId = paymentIntentId;
    order.stripeChargeId = chargeId;
    order.stripeFee = stripeFee;
    await order.save();

    // 1) Enrollments — one per item (section adds to sectionIds, full upgrades).
    for (const item of order.items) {
      await this.upsertEnrollment(
        studentObjId,
        item.courseId,
        item.itemType,
        item.sectionId ?? null,
      );
    }

    // 2) Earnings ledger (per item) + one Stripe Transfer per instructor.
    const { share } = await this.getShare();
    const totalsByInstructor = new Map<string, number>();
    for (const item of order.items) {
      const key = item.instructorId?.toString();
      if (!key) continue;
      totalsByInstructor.set(
        key,
        (totalsByInstructor.get(key) ?? 0) + item.price,
      );
      const itemShare = Math.round(item.price * (share / 100) * 100) / 100;
      await this.earningModel.create({
        instructorId: item.instructorId,
        orderId: order._id,
        courseId: item.courseId,
        sectionId: item.sectionId ?? null,
        amount: itemShare,
        status: EarningStatus.PENDING,
      });
    }

    for (const [instructorId, total] of totalsByInstructor) {
      const shareAmount = Math.round(total * (share / 100) * 100) / 100;
      // Move the share to the instructor's connected account. Best-effort: a
      // failed transfer is logged (the student already has access and the
      // earning ledger stands), it can be reconciled/retried, and it never
      // blocks fulfillment of the rest of the order.
      if (chargeId) {
        const instructor = await this.userModel
          .findById(instructorId)
          .select('stripeAccountId')
          .lean<{ stripeAccountId?: string | null }>()
          .exec();
        if (instructor?.stripeAccountId) {
          try {
            await this.stripe.createTransfer({
              destinationAccountId: instructor.stripeAccountId,
              amountCents: Math.round(shareAmount * 100),
              transferGroup: order._id.toString(),
              sourceTransaction: chargeId,
              idempotencyKey: `transfer_${order._id.toString()}_${instructorId}`,
            });
          } catch (err) {
            this.logger.error(
              `Transfer to ${instructorId} for order ${order._id.toString()} failed: ${(err as Error).message}`,
            );
          }
        }
      }
      const instructorObjId = new Types.ObjectId(instructorId);
      this.notifications
        .create(
          instructorObjId,
          'New Enrollment',
          'A student just purchased content from your courses.',
          NotificationType.NEW_ENROLLMENT,
        )
        .catch(() => {});
      this.notifications
        .create(
          instructorObjId,
          'Earning Recorded',
          `You earned ${shareAmount} from a new purchase.`,
          NotificationType.EARNING_RECORDED,
        )
        .catch(() => {});
    }

    // 3) Student notification + empty the bought items from the cart.
    this.notifications
      .create(
        studentObjId,
        'Purchase Successful',
        'Your purchase is complete. Enjoy your new content!',
        NotificationType.PURCHASE_COMPLETED,
      )
      .catch(() => {});
    await this.clearOrderItemsFromCart(studentObjId, order.items).catch(() => {});
  }

  /** Create or extend a student's enrollment for a purchased item. */
  private async upsertEnrollment(
    studentId: Types.ObjectId,
    courseId: Types.ObjectId,
    itemType: PurchaseType,
    sectionId: Types.ObjectId | null,
  ): Promise<void> {
    let enrollment = await this.enrollmentModel.findOne({ studentId, courseId });
    if (!enrollment) {
      enrollment = new this.enrollmentModel({
        studentId,
        courseId,
        type: itemType,
        sectionIds:
          itemType === PurchaseType.SECTION && sectionId ? [sectionId] : [],
      });
    } else if (itemType === PurchaseType.FULL_COURSE) {
      enrollment.type = PurchaseType.FULL_COURSE;
    } else if (itemType === PurchaseType.SECTION && sectionId) {
      if (
        !enrollment.sectionIds.some((id) => id.toString() === sectionId.toString())
      ) {
        enrollment.sectionIds.push(sectionId);
      }
    }
    await enrollment.save();
  }

  /** Remove just-purchased items (and any section now covered by a full buy). */
  private async clearOrderItemsFromCart(
    studentId: Types.ObjectId,
    items: Array<{
      courseId: Types.ObjectId;
      itemType: PurchaseType;
      sectionId?: Types.ObjectId;
    }>,
  ): Promise<void> {
    const cart = await this.cartModel.findOne({ studentId });
    if (!cart || cart.items.length === 0) return;

    const key = (c: string, t: string, s?: string) => `${c}|${t}|${s ?? ''}`;
    const bought = new Set(
      items.map((i) =>
        key(i.courseId.toString(), i.itemType, i.sectionId?.toString()),
      ),
    );
    const fullCourseBought = new Set(
      items
        .filter((i) => i.itemType === PurchaseType.FULL_COURSE)
        .map((i) => i.courseId.toString()),
    );

    const before = cart.items.length;
    cart.items = cart.items.filter((ci) => {
      const exact = bought.has(
        key(ci.courseId.toString(), ci.itemType, ci.sectionId?.toString()),
      );
      const supersededByFull = fullCourseBought.has(ci.courseId.toString());
      return !exact && !supersededByFull;
    });
    if (cart.items.length === before) return;

    if (cart.items.length === 0) {
      await this.cartModel.deleteOne({ _id: cart._id }).exec();
    } else {
      await cart.save();
    }
  }

  // ---- Disputes (chargebacks) ----------------------------------------------

  private async findOrderForDispute(
    dispute: Stripe.Dispute,
  ): Promise<Awaited<ReturnType<Model<Order>['findOne']>> | null> {
    const paymentIntentId =
      typeof dispute.payment_intent === 'string'
        ? dispute.payment_intent
        : (dispute.payment_intent?.id ?? null);
    if (!paymentIntentId) return null;
    return this.orderModel
      .findOne({ stripePaymentIntentId: paymentIntentId })
      .exec();
  }

  private async notify(
    userId: Types.ObjectId,
    title: string,
    message: string,
    type: string,
  ): Promise<void> {
    try {
      await this.notificationModel.create({
        userId,
        title,
        message,
        type,
        isRead: false,
      });
    } catch {
      /* best-effort */
    }
  }

  private async notifySuperadmins(
    title: string,
    message: string,
  ): Promise<void> {
    const admins = await this.userModel
      .find({ role: UserRole.SUPERADMIN })
      .select('_id')
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();
    await Promise.all(
      admins.map((a) => this.notify(a._id, title, message, 'DISPUTE_OPENED')),
    );
  }

  /**
   * A chargeback was opened. With platform-as-merchant-of-record Stripe already
   * debits the disputed amount + fee from the PLATFORM balance; we just flag the
   * order and alert. No transfer reversal yet — that waits for a LOST outcome.
   */
  async handleDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
    const order = await this.findOrderForDispute(dispute);
    if (!order) {
      this.logger.warn(`dispute.created: no order for PI ${String(dispute.payment_intent)}`);
      return;
    }
    if (order.disputeStatus === 'disputed') return; // idempotent
    order.disputeStatus = 'disputed';
    order.stripeChargeId =
      typeof dispute.charge === 'string' ? dispute.charge : (dispute.charge?.id ?? null);
    await order.save();

    const courseTitle = order.items?.[0]?.courseTitle ?? 'a course';
    const instructorId = await this.orderInstructorId(order);
    if (instructorId) {
      await this.notify(
        instructorId,
        'Payment disputed',
        `A student opened a chargeback on "${courseTitle}". The platform is handling it.`,
        'DISPUTE_OPENED',
      );
    }
    await this.notifySuperadmins(
      'New payment dispute',
      `Chargeback opened on "${courseTitle}" (order ${order._id.toString()}). Amount ${order.totalAmount}.`,
    );
  }

  /**
   * A dispute closed. On LOST: claw the instructor's share back (reverse the
   * destination transfer) and revoke the student's access. On WON: just clear
   * the flag.
   */
  async handleDisputeClosed(dispute: Stripe.Dispute): Promise<void> {
    const order = await this.findOrderForDispute(dispute);
    if (!order) return;
    const courseTitle = order.items?.[0]?.courseTitle ?? 'a course';
    const instructorId = await this.orderInstructorId(order);

    if (dispute.status === 'won') {
      order.disputeStatus = 'won';
      await order.save();
      if (instructorId) {
        await this.notify(
          instructorId,
          'Dispute won',
          `The chargeback on "${courseTitle}" was resolved in our favour.`,
          'DISPUTE_RESOLVED',
        );
      }
      return;
    }
    if (dispute.status !== 'lost') return; // still open / other status

    // LOST — reverse the instructor's transfer to recover their share.
    if (order.disputeStatus !== 'lost') {
      try {
        const chargeId =
          order.stripeChargeId ||
          (typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id);
        if (chargeId) {
          const charge = await this.stripe.retrieveCharge(chargeId);
          const transferId =
            typeof charge.transfer === 'string'
              ? charge.transfer
              : (charge.transfer?.id ?? null);
          if (transferId) {
            order.stripeTransferId = transferId;
            await this.stripe.reverseTransfer(transferId);
          }
        }
      } catch (err) {
        this.logger.error(
          `Transfer reversal failed for order ${order._id.toString()}: ${(err as Error).message}`,
        );
      }
    }

    order.disputeStatus = 'lost';
    await order.save();

    // Claw back the earning + revoke access.
    await this.earningModel
      .updateMany(
        { orderId: order._id, status: { $ne: EarningStatus.REVERSED } },
        { $set: { status: EarningStatus.REVERSED } },
      )
      .exec();
    const courseId = order.items?.[0]?.courseId;
    if (courseId) {
      await this.enrollmentModel
        .deleteOne({ studentId: order.studentId, courseId })
        .exec();
    }

    if (instructorId) {
      await this.notify(
        instructorId,
        'Dispute lost',
        `The chargeback on "${courseTitle}" was lost. Your share was reversed and the student's access removed.`,
        'DISPUTE_RESOLVED',
      );
    }
    await this.notifySuperadmins(
      'Dispute lost',
      `Chargeback lost on "${courseTitle}" (order ${order._id.toString()}). Transfer reversed, access revoked.`,
    );
  }

  private async orderInstructorId(
    order: { items?: { courseId?: Types.ObjectId }[] },
  ): Promise<Types.ObjectId | null> {
    const courseId = order.items?.[0]?.courseId;
    if (!courseId) return null;
    const course = await this.courseModel
      .findById(courseId)
      .select('instructorId')
      .lean<{ instructorId?: Types.ObjectId }>()
      .exec();
    return course?.instructorId ?? null;
  }

  // ---- Payouts (superadmin-approved) ---------------------------------------

  private async notifyPayout(
    instructorId: Types.ObjectId,
    type: 'PAYOUT_PROCESSED' | 'PAYOUT_FAILED',
    title: string,
    message: string,
  ): Promise<void> {
    try {
      await this.notificationModel.create({
        userId: instructorId,
        title,
        message,
        type,
        isRead: false,
      });
    } catch {
      /* best-effort */
    }
  }

  /**
   * Fire the Stripe payout for an approved request. Called by SuperAdminService
   * on approve. Sets PROCESSING + gatewayReference, or FAILED on error (rethrows).
   */
  async createInstructorPayout(request: PayoutRequest): Promise<void> {
    const doc = request as PayoutRequest & {
      _id: Types.ObjectId;
      instructorId: Types.ObjectId;
      amount: number;
      status: PayoutRequestStatus;
      save: () => Promise<unknown>;
    };
    const instructor = await this.userModel
      .findById(doc.instructorId)
      .select('stripeAccountId')
      .lean<{ stripeAccountId?: string | null }>()
      .exec();
    const accountId = instructor?.stripeAccountId;

    if (!this.stripe.isConfigured || !accountId) {
      doc.status = PayoutRequestStatus.FAILED;
      doc.failureReason = accountId
        ? 'Stripe is not configured.'
        : 'Instructor has no Stripe account.';
      await doc.save();
      throw new ServiceUnavailableException(doc.failureReason);
    }

    try {
      const amountCents = Math.round(doc.amount * 100);
      const payout = await this.stripe.createPayout(
        accountId,
        amountCents,
        doc._id.toString(),
      );
      doc.status = PayoutRequestStatus.PROCESSING;
      doc.method = 'stripe';
      doc.gatewayProvider = 'stripe';
      doc.gatewayReference = payout.id;
      doc.reference = payout.id;
      doc.failureReason = null;
      await doc.save();
      await this.notifyPayout(
        doc.instructorId,
        'PAYOUT_PROCESSED',
        'Payout on its way',
        `Your payout of ${doc.amount} is being sent to your bank via Stripe.`,
      );
    } catch (err) {
      const reason = (err as Error).message || 'Stripe payout failed';
      doc.status = PayoutRequestStatus.FAILED;
      doc.failureReason = reason;
      await doc.save();
      await this.notifyPayout(
        doc.instructorId,
        'PAYOUT_FAILED',
        'Payout failed',
        reason,
      );
      throw new ServiceUnavailableException(`Stripe payout failed: ${reason}`);
    }
  }

  private async markSucceeded(
    doc: PayoutRequest & {
      _id: Types.ObjectId;
      instructorId: Types.ObjectId;
      amount: number;
      save: (opts?: unknown) => Promise<unknown>;
    },
  ): Promise<void> {
    const session = await this.earningModel.db.startSession();
    session.startTransaction();
    try {
      await this.earningModel.updateMany(
        { instructorId: doc.instructorId, status: EarningStatus.REQUESTED },
        { $set: { status: EarningStatus.PAID_OUT } },
        { session },
      );
      doc.status = PayoutRequestStatus.APPROVED;
      doc.failureReason = null;
      doc.processedAt = new Date();
      await doc.save({ session });
      await session.commitTransaction();
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
    await this.notifyPayout(
      doc.instructorId,
      'PAYOUT_PROCESSED',
      'Payout completed',
      `Your payout of ${doc.amount} has been paid to your bank.`,
    );
  }

  private async markFailed(
    doc: PayoutRequest & {
      instructorId: Types.ObjectId;
      save: () => Promise<unknown>;
    },
    reason: string,
  ): Promise<void> {
    doc.status = PayoutRequestStatus.FAILED;
    doc.failureReason = reason;
    await doc.save();
    await this.notifyPayout(
      doc.instructorId,
      'PAYOUT_FAILED',
      'Payout failed',
      reason,
    );
  }

  /**
   * Poll Stripe for the payout status of a PROCESSING request and finalize it.
   * Used by the superadmin "sync" button (no webhook needed).
   */
  async finalizePayoutStatus(
    requestId: string,
  ): Promise<{ status: PayoutRequestStatus; detail?: string }> {
    const doc = await this.payoutRequestModel.findById(requestId).exec();
    if (!doc) return { status: PayoutRequestStatus.FAILED, detail: 'Not found' };
    if (doc.status !== PayoutRequestStatus.PROCESSING) {
      return { status: doc.status, detail: 'Not in progress' };
    }
    if (!doc.gatewayReference) {
      return { status: doc.status, detail: 'No gateway reference' };
    }
    const instructor = await this.userModel
      .findById(doc.instructorId)
      .select('stripeAccountId')
      .lean<{ stripeAccountId?: string | null }>()
      .exec();
    if (!instructor?.stripeAccountId) {
      return { status: doc.status, detail: 'Instructor has no Stripe account' };
    }

    const payout = await this.stripe.retrievePayout(
      instructor.stripeAccountId,
      doc.gatewayReference,
    );
    return this.applyPayoutStatus(doc as never, payout.status);
  }

  /** Finalize from a webhook payout.paid / payout.failed event. */
  async applyPayoutWebhook(
    payout: Stripe.Payout,
    accountId?: string | null,
  ): Promise<void> {
    // Legacy manual flow: a superadmin-fired payout tracked as a PayoutRequest.
    const doc = await this.payoutRequestModel
      .findOne({ gatewayReference: payout.id })
      .exec();
    if (doc && doc.status === PayoutRequestStatus.PROCESSING) {
      await this.applyPayoutStatus(doc as never, payout.status);
      return;
    }

    // Automatic flow (destination charges): Stripe pays the connected account's
    // balance out to the instructor's bank on its schedule. On `payout.paid`,
    // reconcile that instructor's PENDING earnings → PAID_OUT so the platform DB
    // reflects money that actually left Stripe.
    if (payout.status === 'paid' && accountId) {
      await this.reconcileAutomaticPayout(accountId, payout);
    }
  }

  /**
   * Mark an instructor's oldest PENDING earnings as PAID_OUT to cover a completed
   * Stripe payout to their bank. Matches FIFO up to the payout amount (each sale's
   * destination transfer == that Earning's net share), so partial/rolling payouts
   * only settle what they actually covered. Idempotent on the Stripe payout id.
   */
  private async reconcileAutomaticPayout(
    accountId: string,
    payout: Stripe.Payout,
    opts: { dryRun?: boolean; notify?: boolean } = {},
  ): Promise<{ settled: number; amount: number }> {
    const { dryRun = false, notify = true } = opts;
    const none = { settled: 0, amount: 0 };

    const instructor = await this.userModel
      .findOne({ stripeAccountId: accountId })
      .select('_id')
      .lean<{ _id: Types.ObjectId }>()
      .exec();
    if (!instructor) {
      this.logger.warn(
        `payout.paid for unknown connected account ${accountId} (payout ${payout.id})`,
      );
      return none;
    }

    // Idempotency: this payout id was already reconciled.
    const already = await this.earningModel
      .exists({ stripePayoutId: payout.id })
      .exec();
    if (already) return none;

    const payoutAmount = (payout.amount ?? 0) / 100; // cents → major units
    if (payoutAmount <= 0) return none;

    const pending = await this.earningModel
      .find({
        instructorId: instructor._id,
        status: EarningStatus.PENDING,
      })
      .sort({ createdAt: 1 }) // oldest first (FIFO)
      .select('_id amount')
      .lean<Array<{ _id: Types.ObjectId; amount: number }>>()
      .exec();
    if (!pending.length) return none;

    // Accumulate oldest-first while the running total stays within the payout
    // amount (small epsilon absorbs rounding / minor Stripe fee deltas).
    const EPSILON = 0.01;
    const toSettle: Types.ObjectId[] = [];
    let running = 0;
    for (const e of pending) {
      if (running + e.amount > payoutAmount + EPSILON) break;
      running = Math.round((running + e.amount) * 100) / 100;
      toSettle.push(e._id);
    }
    if (!toSettle.length) return none;

    if (dryRun) return { settled: toSettle.length, amount: running };

    await this.earningModel
      .updateMany(
        { _id: { $in: toSettle }, status: EarningStatus.PENDING },
        {
          $set: {
            status: EarningStatus.PAID_OUT,
            stripePayoutId: payout.id,
            paidOutAt: new Date(),
          },
        },
      )
      .exec();

    if (notify) {
      await this.notifyPayout(
        instructor._id,
        'PAYOUT_PROCESSED',
        'Payout completed',
        `Stripe paid ${running.toFixed(2)} to your bank.`,
      );
    }
    return { settled: toSettle.length, amount: running };
  }

  /**
   * One-off BACKFILL: reconcile historical Stripe `paid` payouts into PAID_OUT
   * earnings for every onboarded instructor (or one, via `instructorId`). Idempotent
   * and re-runnable — earnings already stamped with a payout id are skipped, so the
   * FIFO matcher only ever consumes still-PENDING earnings. Pass `dryRun` to preview
   * without writing. By default it does NOT spam old "payout completed" notifications
   * (`notify: false`). Returns a per-instructor summary.
   */
  async backfillPaidPayouts(opts: {
    dryRun?: boolean;
    notify?: boolean;
    instructorId?: string;
  } = {}): Promise<{
    dryRun: boolean;
    instructors: number;
    payoutsSeen: number;
    earningsSettled: number;
    amountSettled: number;
    perInstructor: Array<{
      instructorId: string;
      accountId: string;
      payouts: number;
      settled: number;
      amount: number;
    }>;
  }> {
    if (!this.stripe.isConfigured) {
      throw new ServiceUnavailableException('Stripe is not configured.');
    }
    const { dryRun = false, notify = false, instructorId } = opts;

    const query: Record<string, unknown> = {
      role: UserRole.INSTRUCTOR,
      stripeAccountId: { $exists: true, $nin: [null, ''] },
    };
    if (instructorId) query._id = new Types.ObjectId(instructorId);

    const instructors = await this.userModel
      .find(query)
      .select('_id stripeAccountId')
      .lean<Array<{ _id: Types.ObjectId; stripeAccountId: string }>>()
      .exec();

    const summary = {
      dryRun,
      instructors: instructors.length,
      payoutsSeen: 0,
      earningsSettled: 0,
      amountSettled: 0,
      perInstructor: [] as Array<{
        instructorId: string;
        accountId: string;
        payouts: number;
        settled: number;
        amount: number;
      }>,
    };

    for (const inst of instructors) {
      let payouts: Stripe.Payout[] = [];
      try {
        payouts = await this.stripe.listPaidPayouts(inst.stripeAccountId);
      } catch (err) {
        this.logger.warn(
          `backfill: cannot list payouts for ${inst.stripeAccountId}: ${(err as Error).message}`,
        );
        continue;
      }

      let settled = 0;
      let amount = 0;
      for (const p of payouts) {
        const r = await this.reconcileAutomaticPayout(inst.stripeAccountId, p, {
          dryRun,
          notify,
        });
        settled += r.settled;
        amount = Math.round((amount + r.amount) * 100) / 100;
      }

      summary.payoutsSeen += payouts.length;
      summary.earningsSettled += settled;
      summary.amountSettled = Math.round((summary.amountSettled + amount) * 100) / 100;
      summary.perInstructor.push({
        instructorId: inst._id.toString(),
        accountId: inst.stripeAccountId,
        payouts: payouts.length,
        settled,
        amount,
      });
    }

    return summary;
  }

  private async applyPayoutStatus(
    doc: PayoutRequest & {
      _id: Types.ObjectId;
      instructorId: Types.ObjectId;
      amount: number;
      status: PayoutRequestStatus;
      save: (opts?: unknown) => Promise<unknown>;
    },
    stripeStatus: string,
  ): Promise<{ status: PayoutRequestStatus; detail?: string }> {
    if (stripeStatus === 'paid') {
      await this.markSucceeded(doc);
      return { status: PayoutRequestStatus.APPROVED, detail: 'Paid' };
    }
    if (stripeStatus === 'failed' || stripeStatus === 'canceled') {
      await this.markFailed(doc, `Stripe payout ${stripeStatus}`);
      return { status: PayoutRequestStatus.FAILED, detail: stripeStatus };
    }
    return { status: PayoutRequestStatus.PROCESSING, detail: stripeStatus };
  }
}
