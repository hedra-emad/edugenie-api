import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { PurchaseType } from '../../common/enums/purchase-type.enum';
import { OrderStatus } from '../../common/enums/order-status.enum';

export type OrderDocument = HydratedDocument<Order>;

@Schema({ _id: false })
class OrderItem {
  @Prop({ type: Types.ObjectId, ref: 'Course', required: true })
  courseId: Types.ObjectId;

  @Prop({ type: String, enum: PurchaseType, required: true })
  itemType: PurchaseType;

  @Prop({ type: Types.ObjectId, ref: 'Section' })
  sectionId?: Types.ObjectId;

  // The course's instructor at purchase time — lets multi-instructor cart
  // fulfillment group items and create one Stripe Transfer per instructor.
  @Prop({ type: Types.ObjectId, ref: 'User' })
  instructorId?: Types.ObjectId;

  @Prop({ required: true })
  courseTitle: string;

  @Prop({ required: true })
  price: number;
}

@Schema({ timestamps: true })
export class Order {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  studentId: Types.ObjectId;

  @Prop({ type: [OrderItem], required: true })
  items: OrderItem[];

  @Prop({ required: true, min: 0 })
  totalAmount: number;

  @Prop({ type: String, enum: OrderStatus, default: OrderStatus.PENDING })
  status: OrderStatus;

  @Prop({ type: Date, default: null })
  paidAt: Date | null;

  // Stripe Checkout Session id — set on fulfillment; also the idempotency guard
  // so a replayed checkout.session.completed webhook can't double-fulfill.
 @Prop({ type: String, default: null, unique: true, sparse: true })
 stripeSessionId: string | null;

  // Stripe processing fee charged on this sale (major units, e.g. USD). The
  // platform (merchant of record) absorbs this, so it's netted out of revenue.
  @Prop({ type: Number, default: 0 })
  stripeFee: number;

  // Set when a dispute (chargeback) is handled on this order's charge.
  @Prop({ type: String, default: null })
  stripeChargeId: string | null;

  @Prop({ type: String, default: null })
  stripeTransferId: string | null;

  // null = no dispute; 'disputed' = open chargeback; 'won'/'lost' = resolved.
  @Prop({
    type: String,
    enum: ['disputed', 'won', 'lost'],
    default: null,
  })
  disputeStatus: 'disputed' | 'won' | 'lost' | null;

  @Prop({ type: String, default: null })
  cartSnapshotHash: string | null;
}

export const OrderSchema = SchemaFactory.createForClass(Order);
