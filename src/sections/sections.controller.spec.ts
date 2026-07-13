import { Test, TestingModule } from '@nestjs/testing';
import { SectionsController } from './sections.controller';
import { SectionsService } from './sections.service';
import { UpdateSectionDto } from './dto/update-section.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

describe('SectionsController', () => {
  let controller: SectionsController;
  let service: SectionsService;

  const mockSectionsService = {
    addSection: jest.fn(),
    updateSection: jest.fn(),
    removeSection: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SectionsController],
      providers: [
        {
          provide: SectionsService,
          useValue: mockSectionsService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<SectionsController>(SectionsController);
    service = module.get<SectionsService>(SectionsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('updateSection', () => {
    it('should call sectionsService.updateSection with correct parameters', async () => {
      const courseId = 'course123';
      const sectionId = 'section456';
      const instructorId = 'instructor789';
      const updateDto: UpdateSectionDto = {
        title: 'Updated Section Title',
        description: 'Updated Section Description',
      };
      const user = { userId: instructorId };

      const mockResult = [{ _id: sectionId, ...updateDto }];
      mockSectionsService.updateSection.mockResolvedValue(mockResult);

      const result = await controller.updateSection(
        courseId,
        sectionId,
        updateDto,
        user,
      );

      expect(mockSectionsService.updateSection).toHaveBeenCalledWith(
        courseId,
        sectionId,
        instructorId,
        updateDto,
      );
      // Controller wraps the service result in the standard ApiResponse
      // envelope (`{ success, data }`) — sections.controller.ts:114.
      expect(result).toEqual({ success: true, data: mockResult });
    });
  });
});
