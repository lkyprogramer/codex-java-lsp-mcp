package demomapstruct;

import org.mapstruct.Mapper;
import org.mapstruct.MappingTarget;

@Mapper(uses = AddressMapper.class)
public interface OrderMapper {
  OrderResponse toResponse(OrderEntity source);

  void updateResponse(OrderEntity source, @MappingTarget OrderResponse target);
}
