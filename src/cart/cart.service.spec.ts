import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { CartService } from './cart.service';
import { Cart } from './schema/cart.schema';
import { CoursesService } from '../courses/courses.service';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import {
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PurchaseType } from '../common/enums/purchase-type.enum';

describe('CartService', () => {
  let service: CartService;
  let cartModel: any;
  let coursesService: any;
  let enrollmentsService: any;

  beforeEach(async () => {
    cartModel = {
      findOne: jest.fn().mockReturnThis(),
      exec: jest.fn(),
      create: jest.fn(),
      // addToCart mutates the cart with two atomic updateOne calls (upsert the
      // row, then guarded item push) — see cart.service.ts:156-183.
      updateOne: jest.fn().mockResolvedValue({}),
    };
    coursesService = {
      findOne: jest.fn(),
      findCourseDocument: jest.fn(),
    };
    enrollmentsService = {
      hasDuplicate: jest.fn(),
      getCourseAccess: jest.fn(),
      getCoursePricingForStudent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CartService,
        { provide: getModelToken(Cart.name), useValue: cartModel },
        { provide: CoursesService, useValue: coursesService },
        { provide: EnrollmentsService, useValue: enrollmentsService },
      ],
    }).compile();

    service = module.get<CartService>(CartService);
  });

  describe('addToCart', () => {
    const studentId = new Types.ObjectId().toString();
    const courseId = new Types.ObjectId().toString();

    it('adds a full-course item priced at the remaining balance', async () => {
      enrollmentsService.hasDuplicate.mockResolvedValue(false);
      coursesService.findCourseDocument.mockResolvedValue({
        _id: courseId,
        price: 100,
        sections: [],
      });
      // Owns nothing yet, so the remaining balance is the full price.
      enrollmentsService.getCoursePricingForStudent.mockResolvedValue({
        remainingPrice: 100,
      });
      jest
        .spyOn(service, 'getCart')
        .mockResolvedValue({ items: [], subtotal: 100, total: 100 });

      const result = await service.addToCart(
        studentId,
        'full_course',
        courseId,
      );

      // Two atomic updateOne calls: row upsert, then the guarded item push.
      expect(cartModel.updateOne).toHaveBeenCalledTimes(2);
      const pushDoc = cartModel.updateOne.mock.calls[1][1];
      expect(pushDoc.$push.items).toMatchObject({
        itemType: 'full_course',
        price: 100, // snapshotted from remainingPrice, not the raw course price
      });
      expect(enrollmentsService.getCoursePricingForStudent).toHaveBeenCalledWith(
        studentId,
        courseId,
      );
      expect(result).toBeDefined();
    });

    it('should reject when student already owns the item', async () => {
      enrollmentsService.hasDuplicate.mockResolvedValue(true);
      await expect(
        service.addToCart(studentId, 'full_course', courseId),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject a section with price null', async () => {
      enrollmentsService.hasDuplicate.mockResolvedValue(false);
      const sectionId = new Types.ObjectId();
      coursesService.findCourseDocument.mockResolvedValue({
        _id: courseId,
        price: 100,
        // Real service does `sections.find(s => s._id.toString() === sectionId)`.
        sections: [{ _id: sectionId, price: null }],
      });
      await expect(
        service.addToCart(studentId, 'section', courseId, sectionId.toString()),
      ).rejects.toThrow(BadRequestException);
    });

    it('re-adding the same item is an idempotent no-op, not a conflict', async () => {
      // The refactor moved duplicate-detection into the $elemMatch guard on the
      // push updateOne (cart.service.ts:167-183): a repeat add resolves as a
      // no-op rather than throwing ConflictException. hasDuplicate is about
      // owned content (enrollment), which is false here.
      enrollmentsService.hasDuplicate.mockResolvedValue(false);
      coursesService.findCourseDocument.mockResolvedValue({
        _id: courseId,
        price: 100,
        sections: [],
      });
      enrollmentsService.getCoursePricingForStudent.mockResolvedValue({
        remainingPrice: 100,
      });
      jest
        .spyOn(service, 'getCart')
        .mockResolvedValue({ items: [], subtotal: 0, total: 0 });

      await expect(
        service.addToCart(studentId, 'full_course', courseId),
      ).resolves.toBeDefined();

      // The push is filtered so an equivalent item is never inserted twice.
      const pushFilter = cartModel.updateOne.mock.calls[1][0];
      expect(pushFilter.items.$not.$elemMatch).toHaveProperty('courseId');
    });
  });

  describe('addCourseSmart', () => {
    const studentId = new Types.ObjectId().toString();
    const courseId = new Types.ObjectId().toString();
    const s1 = new Types.ObjectId();
    const s2 = new Types.ObjectId();
    const s3 = new Types.ObjectId();

    beforeEach(() => {
      enrollmentsService.getCourseAccess = jest.fn();
      coursesService.findCourseDocument = jest.fn();
      jest
        .spyOn(service, 'getCart')
        .mockResolvedValue({ items: [], subtotal: 0, total: 0 });
    });

    it('owns nothing → adds the full course once', async () => {
      enrollmentsService.getCourseAccess.mockResolvedValue({
        accessType: 'none',
        accessibleSections: [],
        totalSections: 3,
      });
      const add = jest
        .spyOn(service, 'addToCart')
        .mockResolvedValue({ items: [], subtotal: 0, total: 0 });

      await service.addCourseSmart(studentId, courseId);

      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith(
        studentId,
        PurchaseType.FULL_COURSE,
        courseId,
      );
    });

    it('owns some, all remaining priced → adds each unowned section', async () => {
      enrollmentsService.getCourseAccess.mockResolvedValue({
        accessType: 'section',
        accessibleSections: [s1.toString()],
        totalSections: 3,
      });
      coursesService.findCourseDocument.mockResolvedValue({
        sections: [
          { _id: s1, price: 10 },
          { _id: s2, price: 20 },
          { _id: s3, price: 30 },
        ],
      });
      const add = jest
        .spyOn(service, 'addToCart')
        .mockResolvedValue({ items: [], subtotal: 0, total: 0 });

      await service.addCourseSmart(studentId, courseId);

      expect(add).toHaveBeenCalledTimes(2);
      expect(add).toHaveBeenCalledWith(
        studentId,
        PurchaseType.SECTION,
        courseId,
        s2.toString(),
      );
      expect(add).toHaveBeenCalledWith(
        studentId,
        PurchaseType.SECTION,
        courseId,
        s3.toString(),
      );
      expect(add).not.toHaveBeenCalledWith(
        studentId,
        PurchaseType.FULL_COURSE,
        courseId,
      );
    });

    it('owns some, a remaining section is unpriced → falls back to full course', async () => {
      enrollmentsService.getCourseAccess.mockResolvedValue({
        accessType: 'section',
        accessibleSections: [s1.toString()],
        totalSections: 3,
      });
      coursesService.findCourseDocument.mockResolvedValue({
        sections: [
          { _id: s1, price: 10 },
          { _id: s2, price: 20 },
          { _id: s3, price: null },
        ],
      });
      const add = jest
        .spyOn(service, 'addToCart')
        .mockResolvedValue({ items: [], subtotal: 0, total: 0 });

      await service.addCourseSmart(studentId, courseId);

      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith(
        studentId,
        PurchaseType.FULL_COURSE,
        courseId,
      );
    });

    it('already fully owns → ConflictException', async () => {
      enrollmentsService.getCourseAccess.mockResolvedValue({
        accessType: 'full_course',
        accessibleSections: [s1.toString(), s2.toString(), s3.toString()],
        totalSections: 3,
      });
      const add = jest.spyOn(service, 'addToCart');

      await expect(
        service.addCourseSmart(studentId, courseId),
      ).rejects.toThrow(ConflictException);
      expect(add).not.toHaveBeenCalled();
    });

    it('swallows a per-section "already in cart" conflict and keeps going', async () => {
      enrollmentsService.getCourseAccess.mockResolvedValue({
        accessType: 'section',
        accessibleSections: [s1.toString()],
        totalSections: 3,
      });
      coursesService.findCourseDocument.mockResolvedValue({
        sections: [
          { _id: s1, price: 10 },
          { _id: s2, price: 20 },
          { _id: s3, price: 30 },
        ],
      });
      const add = jest
        .spyOn(service, 'addToCart')
        .mockRejectedValueOnce(new ConflictException('already in cart'))
        .mockResolvedValue({ items: [], subtotal: 0, total: 0 });

      await expect(
        service.addCourseSmart(studentId, courseId),
      ).resolves.toBeDefined();
      expect(add).toHaveBeenCalledTimes(2);
    });
  });

  describe('validateCart', () => {
    it('re-prices a full-course item to the remaining balance (not the raw price)', async () => {
      const studentId = new Types.ObjectId().toString();
      const courseId = new Types.ObjectId();
      const mockCart = {
        _id: new Types.ObjectId(),
        items: [
          {
            itemType: PurchaseType.FULL_COURSE,
            courseId,
            sectionId: undefined,
            price: 78,
          },
        ],
        save: jest.fn(),
      };
      cartModel.findOne = jest.fn().mockResolvedValue(mockCart);
      enrollmentsService.hasDuplicate = jest.fn().mockResolvedValue(false);
      coursesService.findCourseDocument = jest
        .fn()
        .mockResolvedValue({ price: 628, sections: [] });
      enrollmentsService.getCoursePricingForStudent = jest
        .fn()
        .mockResolvedValue({ remainingPrice: 78 });

      const result = await service.validateCart(studentId);

      // Priced at remaining (78) → unchanged → no throw, no save.
      expect(result).toBe(mockCart);
      expect(mockCart.save).not.toHaveBeenCalled();
      expect(enrollmentsService.getCoursePricingForStudent).toHaveBeenCalled();
    });
  });

  describe('removeFromCart', () => {
    it('should throw NotFoundException if item not in cart', async () => {
      const studentId = new Types.ObjectId().toString();
      const mockCart = {
        studentId: new Types.ObjectId(studentId),
        items: [],
        save: jest.fn(),
      };
      cartModel.findOne = jest.fn().mockResolvedValue(mockCart);
      await expect(
        service.removeFromCart(studentId, new Types.ObjectId().toString()),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
